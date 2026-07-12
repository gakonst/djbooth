import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import { version } from "../src/index.js";

describe("package", () => {
  it("exports its version", () => {
    const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };
    expect(version).toBe(packageJson.version);
  });
});
