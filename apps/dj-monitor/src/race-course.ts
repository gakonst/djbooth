import * as THREE from "three";

const TAU = Math.PI * 2;
const SAMPLES = 1024;

export const wrapRaceDistance = (distance: number, length: number) =>
  ((distance % length) + length) % length;

/** A closed, arc-length sampled course. Position AND banking meet at the lap seam. */
export function createRaceCourse() {
  const controlPoints = Array.from({ length: 16 }, (_, i) => {
    const angle = (i / 16) * TAU;
    const radius = 185 + Math.sin(angle * 3) * 38;
    return new THREE.Vector3(
      Math.sin(angle) * radius,
      Math.sin(angle * 2) * 24 + Math.cos(angle * 3) * 9,
      Math.cos(angle) * (radius + 30),
    );
  });
  const curve = new THREE.CatmullRomCurve3(controlPoints, true, "centripetal");
  curve.arcLengthDivisions = SAMPLES * 4;
  const length = curve.getLength();
  const points = curve.getSpacedPoints(SAMPLES);
  const rotations: THREE.Quaternion[] = [];
  const worldUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const back = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const bank = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i <= SAMPLES; i++) {
    const u = i / SAMPLES;
    const tangent = curve.getTangentAt(u);
    right.crossVectors(tangent, worldUp).normalize();
    up.crossVectors(right, tangent).normalize();
    back.copy(tangent).negate();
    basis.makeBasis(right, up, back);
    bank.setFromAxisAngle(axis, Math.sin(u * TAU * 3) * 0.22);
    rotations.push(new THREE.Quaternion().setFromRotationMatrix(basis).multiply(bank));
  }
  // Exact closure also avoids numerical drift in repeated end-to-start interpolation.
  points[SAMPLES]!.copy(points[0]!);
  rotations[SAMPLES]!.copy(rotations[0]!);
  return {
    length,
    sample(distance: number, position: THREE.Vector3, rotation: THREE.Quaternion) {
      const progress = (wrapRaceDistance(distance, length) / length) * SAMPLES;
      const i = Math.floor(progress);
      const fraction = progress - i;
      position.copy(points[i]!).lerp(points[i + 1]!, fraction);
      rotation.copy(rotations[i]!).slerp(rotations[i + 1]!, fraction);
    },
  };
}

export type RaceDrive = { distance: number; speed: number; clock: number };

/** Integrate velocity: changing a fader or speed never relocates the camera. */
export function advanceRace(
  drive: RaceDrive,
  delta: number,
  length: number,
  motion: number,
  activity: number,
  beat: number,
  reducedMotion: boolean,
) {
  const dt = THREE.MathUtils.clamp(delta, 0, 0.05);
  const movement = reducedMotion ? 0 : THREE.MathUtils.clamp(motion, 0, 2);
  if (movement === 0) {
    drive.speed = 0;
    return;
  }
  const target =
    (44 + THREE.MathUtils.clamp(activity, 0, 1) * 30 + THREE.MathUtils.clamp(beat, 0, 1) * 20) *
    movement;
  drive.speed += (target - drive.speed) * (1 - Math.exp(-dt * 3));
  drive.distance = wrapRaceDistance(drive.distance + drive.speed * dt, length);
  drive.clock += dt * movement;
}
