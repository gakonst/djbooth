import { describe, expect, it } from "vitest";

import { equalPowerGains } from "../src/client/deck-audio.js";

describe("equalPowerGains", () => {
  it("isolates each deck at the ends and maintains power through the midpoint", () => {
    expect(equalPowerGains(-1)).toEqual({ a: 1, b: 0 });
    expect(equalPowerGains(2).a).toBeCloseTo(0, 10);
    expect(equalPowerGains(2).b).toBe(1);
    const midpoint = equalPowerGains(0.5);
    expect(midpoint.a).toBeCloseTo(Math.SQRT1_2, 10);
    expect(midpoint.b).toBeCloseTo(Math.SQRT1_2, 10);
    expect(midpoint.a ** 2 + midpoint.b ** 2).toBeCloseTo(1, 10);
  });
});
