import { describe, expect, it } from "vitest";

import { parseStagehandTargetFromArp, shouldResumeDjLinkBind } from "../src/runtime.js";

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
