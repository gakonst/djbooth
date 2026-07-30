import { randomUUID } from "node:crypto";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const AUTH_ISSUER = "https://auth.openai.com";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_RESPONSES_WEBSOCKET = "wss://chatgpt.com/backend-api/codex/responses";
const OPENAI_RESPONSES_WEBSOCKET = "wss://api.openai.com/v1/responses";
const REFRESH_EARLY_SECONDS = 5 * 60;

type CodexTokenData = {
  id_token?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  account_id?: unknown;
  [key: string]: unknown;
};

type CodexAuthDocument = {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  tokens?: CodexTokenData;
  last_refresh?: unknown;
  [key: string]: unknown;
};

type IdClaims = {
  email?: unknown;
  "https://api.openai.com/profile"?: { email?: unknown };
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: unknown;
    chatgpt_account_is_fedramp?: unknown;
    chatgpt_plan_type?: unknown;
  };
};

type ExpClaims = { exp?: unknown };

export type ResponsesCredential = {
  mode: "api-key" | "chatgpt";
  bearer: string;
  upstreamUrl: string;
  revision: number;
  accountId?: string;
  fedramp?: boolean;
};

export type ResponsesAuthStatus = {
  mode: "api-key" | "chatgpt" | "unavailable";
  email?: string;
  plan?: string;
  message: string;
};

export type ResponsesCredentialProvider = {
  snapshot(): Promise<ResponsesCredential>;
  recoverUnauthorized(rejected: ResponsesCredential): Promise<void>;
  status(): Promise<ResponsesAuthStatus>;
};

type ChatGptRecord = {
  accountId: string;
  accessToken: string;
  document: CodexAuthDocument;
  email?: string;
  fedramp: boolean;
  idToken: string;
  plan?: string;
  raw: string;
  refreshToken: string;
};

type CredentialProviderOptions = {
  apiKey?: string;
  authFile?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

/** Resolve Responses authorization from the shared Codex login, with API-key fallback. */
export function createResponsesCredentialProvider(
  options: CredentialProviderOptions = {},
): ResponsesCredentialProvider {
  const authFile = options.authFile ?? defaultCodexAuthFile();
  const request = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const apiKey = options.apiKey?.trim();
  let revision = 0;
  let lastRaw: string | undefined;
  let refresh: Promise<void> | undefined;

  const load = async (): Promise<ChatGptRecord> => {
    const raw = await readFile(authFile, "utf8");
    const record = parseChatGptRecord(raw, authFile);
    if (lastRaw !== raw) {
      lastRaw = raw;
      revision += 1;
    }
    return record;
  };

  const refreshCurrent = async (rejectedRevision?: number): Promise<void> => {
    if (rejectedRevision !== undefined && rejectedRevision !== revision) return;
    if (refresh) return refresh;
    refresh = (async () => {
      const attempted = await load();
      if (rejectedRevision !== undefined && rejectedRevision !== revision) return;
      const response = await request(`${AUTH_ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: attempted.refreshToken,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const latest = await load();
        if (latest.raw !== attempted.raw) return;
        if (response.status === 401)
          throw new Error("ChatGPT login expired. Run `codex login`, then retry.");
        throw new Error(`ChatGPT authorization refresh failed (HTTP ${String(response.status)})`);
      }
      const body = (await response.json()) as Record<string, unknown>;
      const latest = await load();
      if (latest.raw !== attempted.raw) {
        if (latest.accountId !== attempted.accountId)
          throw new Error("The Codex ChatGPT account changed while refreshing authorization");
        return;
      }
      const nextIdToken = stringValue(body.id_token) ?? attempted.idToken;
      const idClaims = decodeJwt<IdClaims>(nextIdToken, "ID token");
      const nextAccountId = accountId(idClaims) ?? attempted.accountId;
      if (nextAccountId !== attempted.accountId)
        throw new Error("The refreshed ChatGPT credential belongs to a different account");
      const nextTokens = {
        ...attempted.document.tokens,
        id_token: nextIdToken,
        access_token: stringValue(body.access_token) ?? attempted.accessToken,
        refresh_token: stringValue(body.refresh_token) ?? attempted.refreshToken,
        account_id: attempted.accountId,
      };
      const nextDocument: CodexAuthDocument = {
        ...attempted.document,
        auth_mode: "chatgpt",
        tokens: nextTokens,
        last_refresh: new Date(now()).toISOString(),
      };
      await writeAuthFileAtomically(authFile, JSON.stringify(nextDocument, null, 2));
      await load();
    })().finally(() => {
      refresh = undefined;
    });
    return refresh;
  };

  const chatGptSnapshot = async (): Promise<ResponsesCredential> => {
    let record = await load();
    const expiration = jwtExpiration(record.accessToken);
    if (
      expiration !== undefined &&
      expiration <= Math.floor(now() / 1_000) + REFRESH_EARLY_SECONDS
    ) {
      await refreshCurrent(revision);
      record = await load();
    }
    return {
      mode: "chatgpt",
      bearer: record.accessToken,
      upstreamUrl: CHATGPT_RESPONSES_WEBSOCKET,
      revision,
      accountId: record.accountId,
      fedramp: record.fedramp,
    };
  };

  return {
    async snapshot() {
      try {
        return await chatGptSnapshot();
      } catch (error) {
        if (!apiKey) throw safeAuthError(error, authFile);
        return {
          mode: "api-key",
          bearer: apiKey,
          upstreamUrl: OPENAI_RESPONSES_WEBSOCKET,
          revision: 0,
        };
      }
    },
    async recoverUnauthorized(rejected) {
      if (rejected.mode !== "chatgpt") throw new Error("OpenAI API key was rejected");
      await refreshCurrent(rejected.revision);
    },
    async status() {
      try {
        const record = await load();
        return {
          mode: "chatgpt",
          ...(record.email ? { email: record.email } : {}),
          ...(record.plan ? { plan: record.plan } : {}),
          message: record.email
            ? `ChatGPT · ${record.email}`
            : `ChatGPT · account ${record.accountId.slice(0, 8)}…`,
        };
      } catch {
        return apiKey
          ? { mode: "api-key", message: "OpenAI API key" }
          : {
              mode: "unavailable",
              message: "Sign in with `codex login` to enable the assistant",
            };
      }
    },
  };
}

export function defaultCodexAuthFile(): string {
  const explicit = process.env.NANOCODEX_AUTH_FILE?.trim();
  if (explicit) return explicit;
  const codexHome = process.env.CODEX_HOME?.trim();
  return join(codexHome || join(homedir(), ".codex"), "auth.json");
}

function parseChatGptRecord(raw: string, path: string): ChatGptRecord {
  let document: CodexAuthDocument;
  try {
    document = JSON.parse(raw) as CodexAuthDocument;
  } catch {
    throw new Error(`Codex ChatGPT authorization at ${path} is not valid JSON`);
  }
  if (document.auth_mode !== undefined && document.auth_mode !== "chatgpt")
    throw new Error(`Codex is not signed in with ChatGPT at ${path}`);
  const tokens = document.tokens;
  const idToken = stringValue(tokens?.id_token);
  const accessToken = stringValue(tokens?.access_token);
  const refreshToken = stringValue(tokens?.refresh_token);
  if (!idToken || !accessToken || !refreshToken)
    throw new Error(`Codex ChatGPT authorization at ${path} is incomplete`);
  const claims = decodeJwt<IdClaims>(idToken, "ID token");
  const resolvedAccountId = stringValue(tokens?.account_id) ?? accountId(claims);
  if (!resolvedAccountId)
    throw new Error(`Codex ChatGPT authorization at ${path} has no account ID`);
  const auth = claims["https://api.openai.com/auth"];
  const email =
    stringValue(claims.email) ?? stringValue(claims["https://api.openai.com/profile"]?.email);
  const plan = stringValue(auth?.chatgpt_plan_type);
  return {
    accountId: resolvedAccountId,
    accessToken,
    document,
    ...(email ? { email } : {}),
    fedramp: auth?.chatgpt_account_is_fedramp === true,
    idToken,
    ...(plan ? { plan } : {}),
    raw,
    refreshToken,
  };
}

function accountId(claims: IdClaims): string | undefined {
  return stringValue(claims["https://api.openai.com/auth"]?.chatgpt_account_id);
}

function jwtExpiration(token: string): number | undefined {
  try {
    const expiration = decodeJwt<ExpClaims>(token, "access token").exp;
    return typeof expiration === "number" && Number.isFinite(expiration) ? expiration : undefined;
  } catch {
    return undefined;
  }
}

function decodeJwt<T>(token: string, label: string): T {
  const payload = token.split(".")[1];
  if (!payload) throw new Error(`ChatGPT ${label} has an invalid JWT format`);
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as T;
  } catch {
    throw new Error(`ChatGPT ${label} has an invalid payload`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function writeAuthFileAtomically(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.auth-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${contents}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function safeAuthError(error: unknown, authFile: string): Error {
  if (error instanceof Error && !/ENOENT/u.test(error.message)) return error;
  return new Error(`No ChatGPT login found at ${authFile}. Run \`codex login\`, then retry.`);
}
