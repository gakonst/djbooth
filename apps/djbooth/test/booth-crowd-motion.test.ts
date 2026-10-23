import { describe, expect, it } from "vitest";
import {
  estimateCrowdMotion,
  IDLE_CROWD_MOTION,
  smoothCrowdMotion,
} from "../../dj-monitor/src/crowd-motion.js";

const width = 40;
const height = 30;
function frame(background = 60, patch?: { x: number; value: number }) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const value =
        patch && x >= patch.x && x < patch.x + 6 && y >= 8 && y < 22 ? patch.value : background;
      pixels[p] = pixels[p + 1] = pixels[p + 2] = value;
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}
const estimate = (a: Uint8ClampedArray, b: Uint8ClampedArray) =>
  estimateCrowdMotion(a, b, width, height);

describe("local crowd frame differences", () => {
  it("is still for identical frames and uniform exposure changes", () => {
    for (const brightness of [20, 60, 120, 220]) {
      expect(estimate(frame(), frame(brightness))).toEqual({
        active: true,
        energy: 0,
        steering: 0,
      });
    }
  });

  it("mirrors a moving region on the raw image right into negative (user-left) steering", () => {
    const left = estimate(frame(), frame(60, { x: 3, value: 220 }));
    const right = estimate(frame(), frame(60, { x: 31, value: 220 }));
    expect(left.energy).toBeGreaterThan(0.2);
    expect(right.energy).toBeCloseTo(left.energy);
    expect(left.steering).toBeGreaterThan(0.5);
    expect(right.steering).toBeCloseTo(-left.steering);
  });

  it("retains localized motion while compensating a simultaneous exposure shift", () => {
    const reference = estimate(frame(), frame(60, { x: 31, value: 160 }));
    const exposure = estimate(frame(), frame(90, { x: 31, value: 190 }));
    expect(exposure).toEqual(reference);
  });

  it("recenters symmetric motion and rejects small sensor noise", () => {
    expect(estimate(frame(), frame(60, { x: 17, value: 220 })).steering).toBeCloseTo(0);
    expect(estimate(frame(), frame(60, { x: 31, value: 68 })).energy).toBe(0);
  });

  it("needs fresh differences rather than continuing to steer toward a stationary subject", () => {
    const subject = frame(60, { x: 31, value: 220 });
    expect(estimate(frame(), subject).energy).toBeGreaterThan(0);
    expect(estimate(subject, subject)).toEqual({ active: true, energy: 0, steering: 0 });
  });

  it("rejects invalid frame dimensions and sizes", () => {
    expect(estimateCrowdMotion(frame(), frame(), 0, height)).toEqual(IDLE_CROWD_MOTION);
    expect(estimateCrowdMotion(frame(), new Uint8ClampedArray(4), width, height)).toEqual(
      IDLE_CROWD_MOTION,
    );
  });
});

describe("crowd input smoothing", () => {
  const moving = { active: true, energy: 1, steering: -1 };
  it("smooths attack, scales influence, and bounds output", () => {
    const start = smoothCrowdMotion(IDLE_CROWD_MOTION, moving, 1 / 12, 0.5);
    expect(start.energy).toBeGreaterThan(0);
    expect(start.energy).toBeLessThan(0.5);
    expect(start.steering).toBeCloseTo(-start.energy);
    expect(smoothCrowdMotion(IDLE_CROWD_MOTION, moving, 1, 0).energy).toBe(0);
    expect(smoothCrowdMotion(IDLE_CROWD_MOTION, moving, 10, 100).energy).toBeLessThanOrEqual(1);
  });

  it("fades ended/stale input and stillness to zero rather than holding steering", () => {
    for (const target of [IDLE_CROWD_MOTION, { active: true, energy: 0, steering: 0 }]) {
      let output = smoothCrowdMotion(moving, target, 1 / 12);
      expect(output.energy).toBeGreaterThan(0);
      expect(output.energy).toBeLessThan(1);
      for (let i = 0; i < 60; i++) output = smoothCrowdMotion(output, target, 1 / 12);
      expect(output.energy).toBe(0);
      expect(output.steering).toBe(0);
    }
  });

  it("has consistent release over different sampling intervals and decays after suspension", () => {
    let frequent = moving;
    for (let i = 0; i < 12; i++) frequent = smoothCrowdMotion(frequent, IDLE_CROWD_MOTION, 1 / 12);
    const once = smoothCrowdMotion(moving, IDLE_CROWD_MOTION, 1);
    expect(frequent.energy).toBeCloseTo(once.energy);
    expect(frequent.steering).toBeCloseTo(once.steering);
    expect(smoothCrowdMotion(moving, IDLE_CROWD_MOTION, 60)).toEqual(IDLE_CROWD_MOTION);
  });
});
