import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseStagehandTargetFromArp,
  resolveStagehandIdentity,
  shouldResumeDjLinkBind,
} from "../src/runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Stagehand identity", () => {
  it("persists one identity across complete runtime restarts", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "djbooth-stagehand-"));
    temporaryDirectories.push(root);
    const path = resolve(root, "stagehand-identity.json");

    const first = await resolveStagehandIdentity(path);
    const second = await resolveStagehandIdentity(path);

    expect(second).toEqual(first);
    expect(first.sessionNonce).toMatch(/^\d+$/);
    expect(first.protocolNonce).toMatch(/^\d+$/);
    expect(first.protocolNonce).not.toBe(first.sessionNonce);
    await expect(readFile(path, "utf8")).resolves.toContain(first.sessionNonce);
  });

  it("migrates a running peer identity and keeps it", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "djbooth-stagehand-"));
    temporaryDirectories.push(root);
    const path = resolve(root, "stagehand-identity.json");
    const running = {
      sessionIp: "169.254.51.174",
      sessionNonce: "1774010559151420552",
      protocolNonce: "1774010559660464898",
    };

    await expect(resolveStagehandIdentity(path, {}, running)).resolves.toMatchObject(running);
    await expect(resolveStagehandIdentity(path)).resolves.toMatchObject(running);
  });
});

describe("DJ Link bind reconciliation", () => {
  it("restarts a Wi-Fi fallback when DJ Link Ethernet appears", () => {
    expect(
      shouldResumeDjLinkBind("10.0.0.195", undefined, new Set(["10.0.0.195", "169.254.51.208"])),
    ).toBe(false);
  });

  it("keeps the active link-local DJ Link interface", () => {
    expect(
      shouldResumeDjLinkBind(
        "169.254.51.208",
        undefined,
        new Set(["10.0.0.195", "169.254.51.208"]),
      ),
    ).toBe(true);
  });

  it("keeps a routed fallback while Ethernet is unavailable", () => {
    expect(shouldResumeDjLinkBind("10.0.0.195", undefined, new Set(["10.0.0.195"]))).toBe(true);
  });

  it("restarts after its bound interface disappears", () => {
    expect(shouldResumeDjLinkBind("169.254.51.208", undefined, new Set(["10.0.0.195"]))).toBe(
      false,
    );
  });
});

describe("Stagehand target discovery", () => {
  it("finds an A9 by its AlphaTheta protocol OUI in the live ARP table", () => {
    expect(
      parseStagehandTargetFromArp(`
? (169.254.7.4) at 24:97:ed:24:4a:66 on en11 [ethernet]
? (169.254.69.43) at c8:3d:fc:14:45:2b on en11 [ethernet]
`),
    ).toEqual({ ip: "169.254.69.43", mac: "c8:3d:fc:14:45:2b" });
  });

  it("ignores unrelated and incomplete neighbors", () => {
    expect(
      parseStagehandTargetFromArp(`
? (169.254.7.4) at 24:97:ed:24:4a:66 on en11 [ethernet]
? (169.254.69.43) at (incomplete) on en11 [ethernet]
`),
    ).toBeUndefined();
  });
});
