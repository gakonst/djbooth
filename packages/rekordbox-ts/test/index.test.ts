import { describe, expect, it } from "vitest";

import { version } from "../src/index.js";

describe("package", () => {
  it("exports its version", () => {
    expect(version).toBe("0.1.0");
  });
});
