import { describe, expect, it } from "vitest";
import { authenticate, authRoute, digest } from "../src/auth.js";
import type { Env } from "../src/index.js";

const id = `nc_${"a".repeat(64)}`;
const env = { SHARED_LIBRARY_ACCOUNT: id } as Env;
describe("shared-library access", () => {
  it("uses the configured owner for anonymous and old iOS bearer requests without issuer access", async () => {
    for (const headers of [{}, { authorization: "Bearer expired-ios-grant" }]) {
      const account = await authenticate(
        new Request("https://library.test/v1/sync", { headers }),
        env,
      );
      expect(account.id).toBe(id);
      expect(account.capabilities).toEqual([]);
      expect(account.agentId).toBeUndefined();
    }
  });
  it("preserves browser origin restrictions", async () => {
    await expect(
      authenticate(
        new Request("https://library.test/v1/sync", { headers: { origin: "https://other.test" } }),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("returns an iOS-compatible session and allows connecting without Nanocodex", async () => {
    const session = await authRoute(
      new Request("https://library.test/v1/auth/session"),
      env,
      async () => ({}),
    );
    expect(((await session.json()) as { account: { id: string } }).account.id).toBe(id);
    const connected = await authRoute(
      new Request("https://library.test/v1/auth/connect", { method: "POST" }),
      env,
      async () => ({}),
    );
    expect(connected.status).toBe(200);
    expect(connected.headers.get("set-cookie")).toContain("djbooth_connect=shared-library");
  });
  it("rejects misconfiguration and keeps unconfigured deployments private", async () => {
    await expect(
      authenticate(new Request("https://library.test/v1/sync"), {
        SHARED_LIBRARY_ACCOUNT: "bad",
      } as Env),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      authenticate(new Request("https://library.test/v1/sync"), {} as Env),
    ).rejects.toMatchObject({ status: 401 });
  });
});

it("rejects anonymous writes and permits only the private publishing token", async () => {
  const request = (token?: string) =>
    new Request("https://library.test/v1/sync/changes", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  const writerEnv = {
    ...env,
    SHARED_LIBRARY_WRITE_TOKEN_HASH: await digest("operator-test-token"),
  };
  for (const token of [undefined, "shared-library", "expired-ios-grant", "wrong-token"]) {
    await expect(authenticate(request(token), writerEnv)).rejects.toMatchObject({ status: 401 });
  }
  await expect(authenticate(request("operator-test-token"), env)).rejects.toMatchObject({
    status: 401,
  });
  expect((await authenticate(request("operator-test-token"), writerEnv)).id).toBe(id);
});
