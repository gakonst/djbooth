import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { advanceRace, createRaceCourse, type RaceDrive } from "../../dj-monitor/src/race-course.js";

// Resolve Three from the package that owns the course, without adding an app dependency.
type Sample = Parameters<ReturnType<typeof createRaceCourse>["sample"]>;
const { Vector3, Quaternion } = createRequire(
  new URL("../../dj-monitor/package.json", import.meta.url),
)("three") as { Vector3: new () => Sample[1]; Quaternion: new () => Sample[2] };
const course = createRaceCourse();
function sample(distance: number) {
  const position = new Vector3();
  const rotation = new Quaternion();
  course.sample(distance, position, rotation);
  return { position, rotation };
}

describe("endless race course", () => {
  it("meets continuously in position and orientation on both sides of the lap seam", () => {
    const epsilon = course.length / 100000;
    const before = sample(course.length - epsilon);
    const seam = sample(0);
    const after = sample(epsilon);
    for (const neighbor of [before, after]) {
      expect(neighbor.position.distanceTo(seam.position)).toBeLessThan(epsilon * 1.02);
      expect(neighbor.position.distanceTo(seam.position)).toBeGreaterThan(epsilon * 0.95);
      expect(neighbor.rotation.angleTo(seam.rotation)).toBeLessThan(0.01);
      expect(neighbor.rotation.length()).toBeCloseTo(1, 8);
    }
    expect(before.position.distanceTo(after.position)).toBeGreaterThan(epsilon * 1.9);
    expect(before.rotation.angleTo(after.rotation)).toBeLessThan(0.01);
  });

  it("covers uniform physical distance through every portion of the lap", () => {
    const portions = 12;
    const steps = 40;
    const expectedDistance = course.length / portions;
    expect(course.length).toBeGreaterThan(0);
    for (let portion = 0; portion < portions; portion++) {
      let previous = sample(portion * expectedDistance).position;
      let traveled = 0;
      for (let step = 1; step <= steps; step++) {
        const next = sample((portion + step / steps) * expectedDistance).position;
        traveled += next.distanceTo(previous);
        previous = next;
      }
      expect(traveled / expectedDistance).toBeGreaterThan(0.98);
      expect(traveled / expectedDistance).toBeLessThan(1.02);
    }
  });

  it.each([-100, -3, -1, 1, 4, 100])("wraps samples offset by %i complete laps", (laps) => {
    for (const fraction of [0, 0.13, 0.5, 0.999]) {
      const reference = sample(fraction * course.length);
      const wrapped = sample((fraction + laps) * course.length);
      expect(wrapped.position.distanceTo(reference.position)).toBeLessThan(1e-7);
      expect(wrapped.rotation.angleTo(reference.rotation)).toBeLessThan(1e-6);
    }
  });
});

describe("race drive", () => {
  it("integrates smoothly across speed and audio changes, including the lap seam", () => {
    const drive: RaceDrive = { distance: course.length - 0.1, speed: 60, clock: 500 };
    const dt = 1 / 60;
    for (const [motion, activity, beat] of [
      [2, 1, 1],
      [0.2, 0, 0],
      [1, 1, 0],
      [1, 0, 1],
    ] as const) {
      const before = { ...drive };
      advanceRace(drive, 0, course.length, motion, activity, beat, false);
      expect(drive).toEqual(before);
      advanceRace(drive, dt, course.length, motion, activity, beat, false);
      const traveled =
        drive.distance >= before.distance
          ? drive.distance - before.distance
          : course.length - before.distance + drive.distance;
      expect(traveled).toBeGreaterThan(0);
      expect(traveled).toBeLessThanOrEqual(Math.max(before.speed, drive.speed) * dt + 1e-8);
      expect(Math.abs(drive.speed - before.speed)).toBeLessThan(before.speed * 0.25);
      expect(
        sample(drive.distance).position.distanceTo(sample(before.distance).position),
      ).toBeLessThanOrEqual(traveled * 1.02);
      expect(drive.distance).toBeGreaterThanOrEqual(0);
      expect(drive.distance).toBeLessThan(course.length);
    }
  });

  it("caps a long suspended frame to the same movement as a 50ms frame", () => {
    const initial: RaceDrive = { distance: 20, speed: 45, clock: 7 };
    const normal = { ...initial };
    const suspended = { ...initial };
    advanceRace(normal, 0.05, course.length, 2, 1, 1, false);
    advanceRace(suspended, 120, course.length, 2, 1, 1, false);
    expect(suspended).toEqual(normal);
    expect(suspended.distance).toBeGreaterThan(initial.distance);
    expect(suspended.distance - initial.distance).toBeLessThan(course.length * 0.01);
  });

  it.each([
    { label: "zero motion", motion: 0, reduced: false },
    { label: "reduced motion", motion: 2, reduced: true },
  ])("freezes position and clock with $label even while audio is active", ({ motion, reduced }) => {
    const drive: RaceDrive = { distance: course.length - 0.1, speed: 90, clock: 12 };
    const initial = { ...drive };
    for (let frame = 0; frame < 120; frame++) {
      advanceRace(drive, 1 / 60, course.length, motion, 1, 1, reduced);
    }
    expect(drive.distance).toBe(initial.distance);
    expect(drive.clock).toBe(initial.clock);
    expect(drive.speed).toBe(0);
  });

  it("cruises without activity and drives faster with audio and beat energy", () => {
    const idle: RaceDrive = { distance: 0, speed: 0, clock: 0 };
    const active = { ...idle };
    const pulsing = { ...idle };
    for (let frame = 0; frame < 180; frame++) {
      advanceRace(idle, 1 / 60, course.length, 1, 0, 0, false);
      advanceRace(active, 1 / 60, course.length, 1, 1, 0, false);
      advanceRace(pulsing, 1 / 60, course.length, 1, 1, 1, false);
    }
    expect(idle.speed).toBeGreaterThan(0);
    expect(idle.distance).toBeGreaterThan(0);
    expect(active.speed).toBeGreaterThan(idle.speed);
    expect(active.distance).toBeGreaterThan(idle.distance);
    expect(pulsing.speed).toBeGreaterThan(active.speed);
    expect(pulsing.distance).toBeGreaterThan(active.distance);
  });
});
