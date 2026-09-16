import { expect, test, vi } from "vitest";
import { migrateCloudLegacy } from "../src/cloud-migrate.js";

test("migration copies objects before library rows, advances cursors and preserves conflicts", async () => {
  const calls: unknown[] = [];
  const replies = [
    {
      accountId: "owner",
      entities: [{ kind: "track", total: 1, deleted: 0 }],
      imports: 1,
      objects: [{ id: 0, name: "recordings", total: 2, bytes: 20 }],
    },
    { copied: 1, reused: 0, count: 1, cursor: "next" },
    { copied: 0, reused: 1, count: 1, cursor: null },
    { copied: 0, reused: 0, conflicts: ["track:edited"], count: 1, after: 19, done: true },
    { copied: 1, count: 1, conflicts: [] },
  ];
  const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer account-token");
    calls.push(init?.body ? JSON.parse(String(init.body)) : null);
    return Response.json(replies.shift());
  }) as typeof fetch;
  const progress: string[] = [];
  const result = await migrateCloudLegacy(
    {
      endpoint: new URL("https://library.example"),
      token: "account-token",
      onProgress: (phase) => {
        progress.push(phase);
      },
    },
    request,
  );
  expect(calls).toEqual([
    null,
    { phase: "objects", task: 0 },
    { phase: "objects", task: 0, cursor: "next" },
    { phase: "entities", after: 0 },
    { phase: "imports" },
  ]);
  expect(result).toMatchObject({ copiedObjects: 1, reusedObjects: 1, conflicts: ["track:edited"] });
  expect(progress.at(-1)).toBe("needs-attention");
});

test("dry run only inspects and does not mutate", async () => {
  const request = vi.fn(async () =>
    Response.json({ accountId: "owner", entities: [], imports: 0, objects: [] }),
  ) as typeof fetch;
  expect(
    await migrateCloudLegacy(
      { endpoint: new URL("https://library.example"), token: "account-token", dryRun: true },
      request,
    ),
  ).toMatchObject({ dryRun: true });
  expect(request).toHaveBeenCalledTimes(1);
});
