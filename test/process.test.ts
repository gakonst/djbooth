import { describe, expect, test } from "vitest";

import { mapConcurrent } from "../src/process.js";

describe("mapConcurrent", () => {
  test("preserves order and honors the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const result = await mapConcurrent([3, 1, 2], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(value);
      active -= 1;
      return value * 2;
    });
    expect(result).toEqual([6, 2, 4]);
    expect(peak).toBe(2);
  });

  test("waits for in-flight workers before rejecting and starts no later work", async () => {
    let active = 0;
    const started: number[] = [];
    await expect(
      mapConcurrent([1, 2, 3], 2, async (value) => {
        started.push(value);
        active += 1;
        try {
          await delay(value === 1 ? 2 : 10);
          if (value === 1) throw new Error("stop");
          return value;
        } finally {
          active -= 1;
        }
      }),
    ).rejects.toThrow("stop");
    expect(active).toBe(0);
    expect(started).toEqual([1, 2]);
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
