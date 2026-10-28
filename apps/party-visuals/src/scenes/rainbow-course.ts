import * as THREE from "three";
import type { SongMap, Style } from "../music/song-map.js";

/** Samples per second of song time. */
export const COURSE_RATE = 30;
const EXTRA_SECONDS = 30;

export const STYLES: Style[] = ["break", "vocal", "groove", "build", "drop"];
const SPEED: Record<Style, number> = { break: 24, vocal: 32, groove: 36, build: 42, drop: 52 };

/**
 * The road laid out along a song: every sample is where the kart is at that moment of the
 * song. Because the whole song is known in advance, a turn is already visible ahead before
 * the section change that causes it.
 */
export type Course = {
  count: number;
  position: Float32Array;
  tangent: Float32Array;
  up: Float32Array;
  right: Float32Array;
  /** Distance travelled, for seams that stay put on the road. */
  distance: Float32Array;
  style: Uint8Array;
  energy: Float32Array;
  /** Sample indices of item-box rows and dash panels. */
  items: number[];
  dashes: number[];
};

const smoother = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/** A turn of `angle` radians spread over `width` seconds centred on `at`, as a yaw rate. */
function turnRate(time: number, at: number, width: number, angle: number) {
  const s = (time - (at - width / 2)) / width;
  if (s < 0 || s > 1) return 0;
  return (angle * (1 - Math.cos(2 * Math.PI * s))) / width;
}

export function buildCourse(song: SongMap, speedScale: number): Course {
  const seconds = song.duration + EXTRA_SECONDS;
  const count = Math.ceil(seconds * COURSE_RATE);
  const course: Course = {
    count,
    position: new Float32Array(count * 3),
    tangent: new Float32Array(count * 3),
    up: new Float32Array(count * 3),
    right: new Float32Array(count * 3),
    distance: new Float32Array(count),
    style: new Uint8Array(count),
    energy: new Float32Array(count),
    items: [],
    dashes: [],
  };
  const dt = 1 / COURSE_RATE;
  const bars = song.bars.length ? song.bars : [0];
  const barLength = (i: number) => (bars[i + 1] ?? bars[i]! + 2) - bars[i]!;
  const barAt = (t: number) => {
    let low = 0,
      high = bars.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (bars[mid]! <= t) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  // Decisive moments, worked out once: turns at every change of style, sharp corners
  // through each drop, and corkscrews at irregularities.
  type Turn = { at: number; width: number; angle: number };
  const turns: Turn[] = [];
  let side = 1;
  song.sections.forEach((section, i) => {
    const bar = barLength(barAt(section.start));
    if (i > 0 && section.style !== "drop") {
      side = -side;
      turns.push({ at: section.start, width: bar * 1.5, angle: side * 1.25 });
    }
    if (section.style === "drop") {
      for (let t = section.start + bar * 8; t < section.end - bar * 2; t += bar * 8) {
        side = -side;
        turns.push({ at: t, width: bar, angle: side * Math.PI * 0.5 });
      }
    }
  });
  const swirlLength = (t: number) => barLength(barAt(t)) / 2;

  const position = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);
  const roll = new THREE.Quaternion();
  let heading = 0,
    pitch = 0,
    bank = 0,
    speed = SPEED.vocal,
    distance = 0,
    section = 0,
    lastItems = -Infinity;

  for (let i = 0; i < count; i++) {
    const t = i * dt;
    while (section < song.sections.length - 1 && t >= song.sections[section]!.end) section++;
    const current = song.sections[section]!;
    const style = t < song.duration ? current.style : "vocal";
    const barIndex = barAt(t);
    const bar = barLength(barIndex);
    const energy = song.energy[barIndex] ?? 0.5;
    const into = (t - current.start) / Math.max(0.001, current.end - current.start);

    // Each style has its own way of driving.
    let yawRate = 0,
      pitchTarget = 0;
    if (style === "break") {
      yawRate = 0.1 * Math.sin((2 * Math.PI * t) / (bar * 8));
      pitchTarget = 0.16;
    } else if (style === "vocal") {
      yawRate = 0.22 * Math.sin((2 * Math.PI * t) / (bar * 8));
      pitchTarget = 0.09 * Math.sin((2 * Math.PI * t) / (bar * 4));
    } else if (style === "groove") {
      yawRate = 0.3 * Math.sin((2 * Math.PI * t) / (bar * 4));
      pitchTarget = 0.06 * Math.sin((2 * Math.PI * t) / (bar * 2));
    } else if (style === "build") {
      yawRate = 0.04 * Math.sin((2 * Math.PI * t) / (bar * 2));
      pitchTarget = 0.08 + 0.3 * into;
    } else {
      // Drops plunge as they hit, then run long and straight between sharp corners.
      pitchTarget = t - current.start < bar * 2 ? -0.38 : 0;
    }
    for (const turn of turns) yawRate += turnRate(t, turn.at, turn.width, turn.angle);

    let corkscrew = 0;
    song.swirls.forEach((at, k) => {
      const length = swirlLength(at);
      corkscrew += (k % 2 ? -1 : 1) * 2 * Math.PI * smoother((t - at + length / 2) / length);
    });

    speed += ((t < song.duration ? SPEED[style] : SPEED.vocal) * speedScale - speed) * (1 - Math.exp(-dt * 1.5));
    // Slow easing keeps the road flowing; the music decides where it goes, not how it jolts.
    pitch += (pitchTarget - pitch) * (1 - Math.exp(-dt * 1.6));
    bank += (THREE.MathUtils.clamp(-yawRate * 0.9, -0.75, 0.75) - bank) * (1 - Math.exp(-dt * 2.2));
    heading += yawRate * dt;

    forward.set(Math.sin(heading) * Math.cos(pitch), Math.sin(pitch), -Math.cos(heading) * Math.cos(pitch));
    right.crossVectors(forward, worldUp).normalize();
    up.crossVectors(right, forward).normalize();
    roll.setFromAxisAngle(forward, bank + corkscrew);
    up.applyQuaternion(roll);
    right.applyQuaternion(roll);

    position.toArray(course.position, i * 3);
    forward.toArray(course.tangent, i * 3);
    up.toArray(course.up, i * 3);
    right.toArray(course.right, i * 3);
    course.distance[i] = distance;
    course.style[i] = STYLES.indexOf(style);
    course.energy[i] = energy;

    // Item boxes greet each calmer section; dash panels launch every drop and corner.
    const startsSection = i > 0 && course.style[i] !== course.style[i - 1];
    if (style !== "drop" && style !== "build" && (startsSection || t - lastItems > bar * 8)) {
      course.items.push(i + Math.round(bar * COURSE_RATE));
      lastItems = t;
    }
    if (startsSection && style === "drop") course.dashes.push(i);

    position.addScaledVector(forward, speed * dt);
    distance += speed * dt;
  }
  for (const turn of turns)
    if (Math.abs(turn.angle) > 1.5) course.dashes.push(Math.round((turn.at - turn.width) * COURSE_RATE));
  course.items = course.items.filter((i) => i < count);
  course.dashes = course.dashes.filter((i) => i >= 0 && i < count).sort((a, b) => a - b);
  return course;
}

/** Read one sample's frame, interpolated between samples. */
export function courseFrame(
  course: Course,
  index: number,
  out: { point: THREE.Vector3; tangent: THREE.Vector3; up: THREE.Vector3; right: THREE.Vector3 },
) {
  const f = THREE.MathUtils.clamp(index, 0, course.count - 1.001);
  const i = Math.floor(f),
    a = f - i;
  const lerp = (array: Float32Array, target: THREE.Vector3) =>
    target.set(
      array[i * 3]! + (array[i * 3 + 3]! - array[i * 3]!) * a,
      array[i * 3 + 1]! + (array[i * 3 + 4]! - array[i * 3 + 1]!) * a,
      array[i * 3 + 2]! + (array[i * 3 + 5]! - array[i * 3 + 2]!) * a,
    );
  lerp(course.position, out.point);
  lerp(course.tangent, out.tangent).normalize();
  lerp(course.up, out.up).normalize();
  lerp(course.right, out.right).normalize();
  return out;
}
