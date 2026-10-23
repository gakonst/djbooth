export type CrowdMotion = { active: boolean; energy: number; steering: number };

export const IDLE_CROWD_MOTION: CrowdMotion = { active: false, energy: 0, steering: 0 };

/** RGBA frame differences only: no face detection or motion-direction tracking.
 * Steering is the mirrored horizontal centroid of changed pixels.
 */
export function estimateCrowdMotion(
  previous: Uint8ClampedArray,
  current: Uint8ClampedArray,
  width: number,
  height: number,
): CrowdMotion {
  const count = width * height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 1 ||
    previous.length !== count * 4 ||
    current.length !== count * 4
  )
    return { ...IDLE_CROWD_MOTION };
  const deltas = new Int16Array(count);
  const histogram = new Uint32Array(511);
  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const delta = Math.round(
      ((current[p]! - previous[p]!) * 77 +
        (current[p + 1]! - previous[p + 1]!) * 150 +
        (current[p + 2]! - previous[p + 2]!) * 29) /
        256,
    );
    deltas[i] = delta;
    histogram[delta + 255] = histogram[delta + 255]! + 1;
  }
  // Median signed brightness change rejects exposure shifts without letting a
  // small moving subject drag the background into the motion estimate.
  let median = 0;
  let cumulative = 0;
  for (let bin = 0; bin < histogram.length; bin++) {
    cumulative += histogram[bin]!;
    if (cumulative >= count / 2) {
      median = bin - 255;
      break;
    }
  }
  let weight = 0;
  let centroid = 0;
  for (let i = 0; i < count; i++) {
    const changed = Math.max(0, Math.abs(deltas[i]! - median) - 12);
    weight += changed;
    centroid += changed * (1 - (2 * (i % width)) / (width - 1));
  }
  const energy = Math.min(1, weight / (count * 24));
  return {
    active: true,
    energy,
    steering: weight ? (centroid / weight) * Math.min(1, energy * 6) : 0,
  };
}

/** Frame-rate independent attack/release; inactive/stale targets release to zero. */
export function smoothCrowdMotion(
  previous: CrowdMotion,
  target: CrowdMotion,
  elapsedSeconds: number,
  influence = 1,
): CrowdMotion {
  const strength = Number.isFinite(influence) ? Math.min(1, Math.max(0, influence)) : 0;
  const dt = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const energy = target.active ? Math.min(1, Math.max(0, target.energy)) * strength : 0;
  const steering = target.active ? Math.min(1, Math.max(-1, target.steering)) * strength : 0;
  const blend = 1 - Math.exp(-dt / (energy > previous.energy ? 0.15 : 0.35));
  const settle = (value: number) => (Math.abs(value) < 0.0001 ? 0 : value);
  return {
    active: target.active,
    energy: settle(previous.energy + (energy - previous.energy) * blend),
    steering: settle(previous.steering + (steering - previous.steering) * blend),
  };
}
