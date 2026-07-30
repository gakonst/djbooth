import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createResponsesCredentialProvider } from "../src/server/openai-auth.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Responses authorization", () => {
  it("uses the shared Codex ChatGPT login without exposing refresh credentials", async () => {
    const authFile = await fixtureAuthFile({ expiresAt: 2_000_000_000 });
    const provider = createResponsesCredentialProvider({
      authFile,
      now: () => 1_900_000_000_000,
    });

    await expect(provider.status()).resolves.toEqual({
      mode: "chatgpt",
      email: "dj@example.com",
      plan: "pro",
      message: "ChatGPT · dj@example.com",
    });
    await expect(provider.snapshot()).resolves.toMatchObject({
      mode: "chatgpt",
      bearer: "header.eyJleHAiOjIwMDAwMDAwMDB9.signature",
      upstreamUrl: "wss://chatgpt.com/backend-api/codex/responses",
      accountId: "account-1",
      fedramp: false,
    });
  });

  it("refreshes an expiring login atomically and preserves unknown Codex fields", async () => {
    const authFile = await fixtureAuthFile({ expiresAt: 1_900_000_100 });
    const refreshedAccess = jwt({ exp: 2_000_000_000 });
    const request = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            access_token: refreshedAccess,
            refresh_token: "refresh-2",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const provider = createResponsesCredentialProvider({
      authFile,
      fetch: request as typeof fetch,
      now: () => 1_900_000_000_000,
    });

    await expect(provider.snapshot()).resolves.toMatchObject({
      mode: "chatgpt",
      bearer: refreshedAccess,
      accountId: "account-1",
    });
    expect(request).toHaveBeenCalledOnce();
    const requestBody = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(requestBody).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
    });
    const stored = JSON.parse(await readFile(authFile, "utf8")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      auth_mode: "chatgpt",
      custom: "preserved",
      tokens: {
        access_token: refreshedAccess,
        refresh_token: "refresh-2",
        token_extra: "preserved",
      },
    });
  });

  it("falls back to an API key when no shared ChatGPT login exists", async () => {
    const directory = await temporaryDirectory();
    const provider = createResponsesCredentialProvider({
      authFile: join(directory, "missing.json"),
      apiKey: "platform-key",
    });

    await expect(provider.status()).resolves.toEqual({
      mode: "api-key",
      message: "OpenAI API key",
    });
    await expect(provider.snapshot()).resolves.toMatchObject({
      mode: "api-key",
      bearer: "platform-key",
      upstreamUrl: "wss://api.openai.com/v1/responses",
    });
  });
});

async function fixtureAuthFile({ expiresAt }: { expiresAt: number }): Promise<string> {
  const directory = await temporaryDirectory();
  const path = join(directory, "auth.json");
  await writeFile(
    path,
    JSON.stringify({
      auth_mode: "chatgpt",
      custom: "preserved",
      tokens: {
        id_token: jwt({
          email: "dj@example.com",
          "https://api.openai.com/auth": {
            chatgpt_account_id: "account-1",
            chatgpt_account_is_fedramp: false,
            chatgpt_plan_type: "pro",
          },
        }),
        access_token: jwt({ exp: expiresAt }),
        refresh_token: "refresh-1",
        account_id: "account-1",
        token_extra: "preserved",
      },
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return path;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rekordbox-auth-"));
  temporaryDirectories.push(directory);
  return directory;
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}
