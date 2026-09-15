import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { cloudCredentialPath, loginCloud } from "../src/cloud-login.js";

describe("Nanocodex CLI login", () => {
  test("loopback callback validates state and exchanges its one-time code with the original proof", async () => {
    const code = "c".repeat(64);
    let challenge: string | null = null;
    const exchange = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://library.example/v1/auth/exchange");
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body));
      expect(body.code).toBe(code);
      expect(createHash("sha256").update(body.verifier).digest("hex")).toBe(challenge);
      return Response.json({
        token: `nc1.0x${"1".repeat(64)}.${"a".repeat(43)}`,
        account: { id: `nc_${"d".repeat(64)}` },
      });
    });
    let callbackTest: Promise<void> | undefined;
    const result = await loginCloud(new URL("https://library.example"), {
      fetch: exchange,
      save: false,
      open: (value) => {
        const login = new URL(value);
        challenge = login.searchParams.get("challenge");
        const callback = new URL(login.searchParams.get("return")!);
        callback.searchParams.set("code", code);
        callback.searchParams.set("state", "wrong");
        callbackTest = (async () => {
          expect((await fetch(callback)).status).toBe(400);
          callback.searchParams.set("state", login.searchParams.get("state")!);
          expect((await fetch(callback)).status).toBe(200);
        })();
      },
    });
    await callbackTest;
    expect(result.accountId).toBe(`nc_${"d".repeat(64)}`);
    expect(result).not.toHaveProperty("token");
    expect(exchange).toHaveBeenCalledOnce();
  });
  test("timeout closes the login listener", async () => {
    let callback: string | null = null;
    await expect(
      loginCloud(new URL("https://library.example"), {
        save: false,
        timeoutMs: 20,
        open: (value) => {
          callback = new URL(value).searchParams.get("return");
        },
      }),
    ).rejects.toThrow("timed out");
    await expect(fetch(callback!)).rejects.toThrow();
  });
  test("credentials are stored separately for each canonical endpoint", () => {
    expect(cloudCredentialPath(new URL("https://a.test"))).not.toBe(
      cloudCredentialPath(new URL("https://b.test")),
    );
    expect(cloudCredentialPath(new URL("https://a.test:443/"))).toBe(
      cloudCredentialPath(new URL("https://a.test")),
    );
  });
});
