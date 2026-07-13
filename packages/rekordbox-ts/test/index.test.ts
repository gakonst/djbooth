import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { version } from "../src/index.js";

describe("package", () => {
  it("exports its version", () => {
    const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };
    expect(version).toBe(packageJson.version);
  });

  it("keeps private analyzer helpers and vendor runtimes out of the public package", () => {
    const packageJson = createRequire(import.meta.url)("../package.json") as {
      bin: Record<string, string>;
      files: Array<string>;
    };

    expect(packageJson.bin).not.toHaveProperty("rekordbox-analyzer");
    expect(packageJson.files).not.toContain("vendor");
  });
});
