import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { COURSE_RATE, courseFrame, type Course } from "./rainbow-course.js";

/** How far in front of the camera the player's kart drives. */
export const KART_LEAD = 9;

type Frame = { point: THREE.Vector3; tangent: THREE.Vector3; up: THREE.Vector3; right: THREE.Vector3 };
const newFrame = (): Frame => ({
  point: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  up: new THREE.Vector3(),
  right: new THREE.Vector3(),
});

/** The (fractional) course sample at a distance along the road. */
export function indexAtDistance(course: Course, distance: number) {
  const d = course.distance;
  if (distance <= 0) return 0;
  let low = 0,
    high = course.count - 1;
  if (distance >= d[high]!) return high;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (d[mid]! <= distance) low = mid;
    else high = mid;
  }
  return low + (distance - d[low]!) / Math.max(1e-6, d[high]! - d[low]!);
}

type Driver = "cap" | "pumpkin" | "ghost" | "witch" | "skeleton" | "vampire" | "mummy" | "monster";

type Kart = {
  group: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Object3D[];
  flames: THREE.Sprite[];
  paint: THREE.MeshStandardMaterial;
};

function flameTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 128;
  const c = canvas.getContext("2d")!;
  const g = c.createRadialGradient(32, 40, 2, 32, 50, 60);
  g.addColorStop(0, "rgba(255,255,230,1)");
  g.addColorStop(0.25, "rgba(120,200,255,0.95)");
  g.addColorStop(0.6, "rgba(255,120,40,0.6)");
  g.addColorStop(1, "rgba(255,60,0,0)");
  c.fillStyle = g;
  c.beginPath();
  c.ellipse(32, 56, 24, 54, 0, 0, Math.PI * 2);
  c.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function starTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#fff6a0";
  c.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 12 : 30;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    c.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
  }
  c.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Shared kart parts, built once. */
function kartParts() {
  const chassis = new RoundedBoxGeometry(1.8, 0.42, 2.7, 3, 0.18);
  chassis.translate(0, 0.55, 0);
  const nose = new RoundedBoxGeometry(1.3, 0.34, 0.9, 3, 0.14);
  nose.translate(0, 0.5, -1.5);
  const seat = new RoundedBoxGeometry(0.9, 0.45, 0.25, 3, 0.1);
  seat.translate(0, 0.9, 0.85);
  const wheel = new THREE.CylinderGeometry(0.4, 0.4, 0.38, 20).rotateZ(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.2, 0.2, 0.4, 12).rotateZ(Math.PI / 2);
  const pipe = new THREE.CylinderGeometry(0.1, 0.12, 0.5, 10).rotateX(Math.PI / 2);
  const steering = new THREE.TorusGeometry(0.24, 0.045, 8, 20);
  const material = (color: number, roughness = 0.5, metalness = 0) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness });
  return {
    geometries: [chassis, nose, seat, wheel, hub, pipe, steering],
    chassis,
    nose,
    seat,
    wheel,
    hub,
    pipe,
    steering,
    rubber: material(0x18161c, 0.9),
    chrome: material(0xd8d8e0, 0.25, 0.9),
    dark: material(0x22202a, 0.7),
    material,
  };
}

type Parts = ReturnType<typeof kartParts>;

/** A driver on top of the kart, from the waist up, in one of several Halloween costumes. */
function createDriver(type: Driver, color: number, parts: Parts, own: THREE.Material[]) {
  const make = (c: number, roughness = 0.6, emissive = 0) => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness, emissive, emissiveIntensity: emissive ? 1 : 0 });
    own.push(m);
    return m;
  };
  const driver = new THREE.Group();
  driver.position.set(0, 0.9, 0.35);
  const add = (geometry: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, m);
    mesh.position.set(x, y, z);
    driver.add(mesh);
    return mesh;
  };
  const outfit = make(color);
  const skin = make(0xf0c098);
  const black = make(0x111014, 0.8);
  add(new THREE.CapsuleGeometry(0.34, 0.3, 6, 14), outfit, 0, 0.35, 0);
  for (const side of [-1, 1]) {
    const arm = add(new THREE.CapsuleGeometry(0.11, 0.4, 4, 8), outfit, side * 0.34, 0.4, -0.3);
    arm.rotation.x = -1.1;
    add(new THREE.SphereGeometry(0.12, 10, 8), make(0xffffff), side * 0.26, 0.28, -0.62);
  }
  const head = new THREE.Group();
  head.position.set(0, 1.02, 0);
  driver.add(head);
  const part = (geometry: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, m);
    mesh.position.set(x, y, z);
    head.add(mesh);
    return mesh;
  };
  const eyes = (m: THREE.Material, y = 0.05, z = -0.33, size = 0.06) => {
    for (const side of [-1, 1]) part(new THREE.SphereGeometry(size, 10, 8), m, side * 0.12, y, z);
  };
  if (type === "cap") {
    part(new THREE.SphereGeometry(0.36, 20, 16), skin, 0, 0, 0);
    part(new THREE.SphereGeometry(0.38, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), outfit, 0, 0.08, 0);
    part(new THREE.CylinderGeometry(0.3, 0.32, 0.04, 20, 1, false, Math.PI / 2, Math.PI), outfit, 0, 0.1, -0.2);
    part(new THREE.SphereGeometry(0.1, 10, 8), make(0xffb08a), 0, -0.04, -0.36);
    eyes(black, 0.08, -0.3, 0.045);
  } else if (type === "pumpkin") {
    const pumpkin = part(new THREE.SphereGeometry(0.42, 20, 16), make(0xff7a12, 0.7, 0), 0, 0, 0);
    pumpkin.scale.set(1.15, 0.85, 1);
    part(new THREE.CylinderGeometry(0.05, 0.07, 0.2, 8), make(0x3a6a1a), 0, 0.4, 0);
    const glow = make(0xffd040, 0.5, 0xffa000);
    eyes(glow, 0.08, -0.38, 0.08);
    part(new THREE.BoxGeometry(0.34, 0.07, 0.05), glow, 0, -0.13, -0.38);
  } else if (type === "ghost") {
    const sheet = part(new THREE.SphereGeometry(0.42, 20, 16), make(0xf4f2ff, 0.4, 0x302a50), 0, 0, 0);
    sheet.scale.set(1, 1.15, 1);
    eyes(black, 0.08, -0.38, 0.08);
    part(new THREE.SphereGeometry(0.08, 10, 8), black, 0, -0.14, -0.38).scale.set(1, 1.4, 0.6);
  } else if (type === "witch") {
    part(new THREE.SphereGeometry(0.34, 20, 16), make(0x8fd36a), 0, 0, 0);
    part(new THREE.CylinderGeometry(0.62, 0.62, 0.04, 24), black, 0, 0.18, 0);
    const hat = part(new THREE.ConeGeometry(0.32, 0.9, 20), black, 0, 0.62, 0.05);
    hat.rotation.x = 0.25;
    part(new THREE.CylinderGeometry(0.33, 0.33, 0.08, 20), make(0x9b3cff), 0, 0.24, 0);
    eyes(make(0xffee55, 0.4, 0x886600), 0.04, -0.3, 0.05);
    part(new THREE.ConeGeometry(0.06, 0.22, 8), make(0x7cc058), 0, -0.04, -0.4).rotation.x = -Math.PI / 2;
  } else if (type === "skeleton") {
    part(new THREE.SphereGeometry(0.37, 20, 16), make(0xf2eedc, 0.5), 0, 0, 0);
    part(new THREE.BoxGeometry(0.4, 0.2, 0.3), make(0xf2eedc, 0.5), 0, -0.26, -0.08);
    eyes(black, 0.06, -0.3, 0.1);
    part(new THREE.ConeGeometry(0.05, 0.08, 3), black, 0, -0.08, -0.36).rotation.x = Math.PI;
  } else if (type === "vampire") {
    part(new THREE.SphereGeometry(0.35, 20, 16), make(0xdfe2f0), 0, 0, 0);
    part(new THREE.SphereGeometry(0.37, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2.2), black, 0, 0.06, 0.03);
    const collar = part(new THREE.ConeGeometry(0.62, 0.6, 20, 1, true), make(0xb0102a), 0, -0.32, 0.12);
    collar.rotation.x = Math.PI;
    eyes(make(0xff2030, 0.4, 0xaa0000), 0.03, -0.31, 0.05);
  } else if (type === "mummy") {
    const wrap = make(0xe8dcc0, 0.9);
    part(new THREE.SphereGeometry(0.36, 20, 16), wrap, 0, 0, 0);
    for (let k = -2; k <= 2; k++) {
      const band = part(new THREE.TorusGeometry(0.36 - Math.abs(k) * 0.03, 0.03, 6, 24), make(0xcabb98, 0.9), 0, k * 0.12, 0);
      band.rotation.set(Math.PI / 2 + k * 0.15, 0, k * 0.2);
    }
    eyes(make(0x66ff99, 0.4, 0x22aa55), 0.05, -0.32, 0.05);
  } else {
    part(new RoundedBoxGeometry(0.62, 0.7, 0.62, 3, 0.1), make(0x7ac070), 0, 0.05, 0);
    part(new THREE.BoxGeometry(0.66, 0.14, 0.66), black, 0, 0.42, 0);
    for (const side of [-1, 1]) part(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 8).rotateZ(Math.PI / 2), make(0x9a9aa8, 0.3, 0), side * 0.38, -0.12, 0);
    eyes(black, 0.08, -0.32, 0.05);
  }
  return driver;
}

function createKart(parts: Parts, color: number, driver: Driver, flame: THREE.SpriteMaterial, own: THREE.Material[]): Kart {
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.2, emissive: 0x000000 });
  own.push(paint);
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  for (const geometry of [parts.chassis, parts.nose]) body.add(new THREE.Mesh(geometry, paint));
  body.add(new THREE.Mesh(parts.seat, parts.dark));
  const steering = new THREE.Mesh(parts.steering, parts.dark);
  steering.position.set(0, 1.05, -0.45);
  steering.rotation.x = -0.9;
  body.add(steering);
  const wheels: THREE.Object3D[] = [];
  for (const [x, z, scale] of [
    [-0.95, -0.95, 0.85],
    [0.95, -0.95, 0.85],
    [-1, 0.95, 1],
    [1, 0.95, 1],
  ] as const) {
    const wheel = new THREE.Group();
    wheel.position.set(x, 0.4 * scale, z);
    wheel.scale.setScalar(scale);
    wheel.add(new THREE.Mesh(parts.wheel, parts.rubber), new THREE.Mesh(parts.hub, parts.chrome));
    body.add(wheel);
    wheels.push(wheel);
  }
  const flames: THREE.Sprite[] = [];
  for (const x of [-0.45, 0.45]) {
    const pipe = new THREE.Mesh(parts.pipe, parts.chrome);
    pipe.position.set(x, 0.62, 1.45);
    body.add(pipe);
    const sprite = new THREE.Sprite(flame);
    sprite.position.set(x, 0.62, 1.95);
    sprite.visible = false;
    body.add(sprite);
    flames.push(sprite);
  }
  body.add(createDriver(driver, color, parts, own));
  return { group, body, wheels, flames, paint };
}

function createMushroom(own: THREE.Material[], geometries: THREE.BufferGeometry[]) {
  const geometry = <T extends THREE.BufferGeometry>(g: T) => (geometries.push(g), g);
  const material = (color: number, emissive = 0) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.45, emissive, emissiveIntensity: 0.35 });
    own.push(m);
    return m;
  };
  const group = new THREE.Group();
  const cap = new THREE.Mesh(geometry(new THREE.SphereGeometry(0.9, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2)), material(0xe8202a, 0x500000));
  cap.scale.set(1, 0.85, 1);
  cap.position.y = 0.9;
  group.add(cap);
  const white = material(0xffffff, 0x222222);
  for (let i = 0; i < 6; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const tilt = i === 5 ? 0 : 0.9;
    const spot = new THREE.Mesh(geometry(new THREE.SphereGeometry(0.24, 12, 8)), white);
    spot.position.set(Math.sin(tilt) * Math.cos(angle) * 0.82, 0.9 + Math.cos(tilt) * 0.72, Math.sin(tilt) * Math.sin(angle) * 0.82);
    spot.scale.set(1, 0.45, 1);
    spot.lookAt(spot.position.clone().multiplyScalar(2).setY(spot.position.y * 2 - 0.9));
    group.add(spot);
  }
  const stem = new THREE.Mesh(geometry(new THREE.CylinderGeometry(0.48, 0.55, 0.9, 20)), material(0xf5e6c8));
  stem.position.y = 0.48;
  group.add(stem);
  const black = material(0x111111);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(geometry(new THREE.SphereGeometry(0.08, 8, 8)), black);
    eye.scale.set(0.7, 1.5, 0.5);
    eye.position.set(side * 0.16, 0.6, -0.5);
    group.add(eye);
  }
  return group;
}

const RACERS: { color: number; driver: Driver }[] = [
  { color: 0xe82030, driver: "cap" },
  { color: 0x2fbf4a, driver: "cap" },
  { color: 0xff8a10, driver: "pumpkin" },
  { color: 0xe8e4ff, driver: "ghost" },
  { color: 0x7a2cff, driver: "witch" },
  { color: 0x2a2836, driver: "skeleton" },
  { color: 0xb3122e, driver: "vampire" },
  { color: 0xffd23a, driver: "mummy" },
  { color: 0x2aa8ff, driver: "monster" },
];

const ORDINAL = ["1ST", "2ND", "3RD", "4TH", "5TH", "6TH", "7TH", "8TH", "9TH"];

export type RaceInput = {
  course: Course;
  /** Song time and frame clock, in seconds. */
  songTime: number;
  time: number;
  dt: number;
  /** Distance of the player's kart along the road, and its sideways offset. */
  distance: number;
  steer: number;
  density: number;
};

/** The race on Rainbow Road: the player's kart, rivals, items and all the effects. */
export function createRace(parent: THREE.Group, camera: THREE.PerspectiveCamera, host: HTMLCanvasElement) {
  const materials: THREE.Material[] = [];
  const parts = kartParts();
  const geometries: THREE.BufferGeometry[] = [...parts.geometries];
  const flameMap = flameTexture();
  const starMap = starTexture();
  const textures = [flameMap, starMap];
  const additive = (map: THREE.Texture, color = 0xffffff) => {
    const m = new THREE.SpriteMaterial({ map, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    materials.push(m);
    return m;
  };
  const flame = additive(flameMap);
  materials.push(parts.rubber, parts.chrome, parts.dark);

  const player = createKart(parts, RACERS[0]!.color, RACERS[0]!.driver, flame, materials);
  parent.add(player.group);
  const rivals = RACERS.slice(1).map((racer, i) => {
    const kart = createKart(parts, racer.color, racer.driver, flame, materials);
    parent.add(kart.group);
    return {
      kart,
      offset: [-22, -8, 12, 26, 44, 62, 84, 104][i]!,
      lateral: (i % 2 ? 1 : -1) * 3,
      seed: i * 7.3 + 1,
      spin: 0,
      bump: 0,
    };
  });

  // Green shells: one from every item box the player smashes, and now and then between rivals.
  const shellGeometry = new THREE.SphereGeometry(0.55, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  const rimGeometry = new THREE.TorusGeometry(0.56, 0.12, 8, 20).rotateX(Math.PI / 2);
  geometries.push(shellGeometry, rimGeometry);
  const shellMaterial = new THREE.MeshStandardMaterial({ color: 0x22c040, roughness: 0.3, emissive: 0x0a4010 });
  const rimMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  materials.push(shellMaterial, rimMaterial);
  type Shell = { mesh: THREE.Group; rel: number; lateral: number; target: (typeof rivals)[number] | null; age: number };
  const shells: Shell[] = [];
  const pendingShots: number[] = [];
  const throwShell = (from: number, lateral: number) => {
    const target =
      rivals
        .filter((r) => r.offset > from + 4 && r.offset < from + 90 && r.spin <= 0)
        .sort((a, b) => a.offset - b.offset)[0] ?? null;
    const mesh = new THREE.Group();
    mesh.add(new THREE.Mesh(shellGeometry, shellMaterial), new THREE.Mesh(rimGeometry, rimMaterial));
    parent.add(mesh);
    shells.push({ mesh, rel: from + 2, lateral, target, age: 0 });
  };

  // Stars burst from a kart that gets hit.
  const starMaterial = additive(starMap, 0xffffff);
  const bursts: { sprite: THREE.Sprite; rel: number; lateral: number; velocity: THREE.Vector3; age: number; owner: (typeof rivals)[number] }[] = [];
  const spinOut = (rival: (typeof rivals)[number]) => {
    rival.spin = 1.1;
    for (let k = 0; k < 6; k++) {
      const sprite = new THREE.Sprite(starMaterial);
      sprite.scale.setScalar(0.8);
      parent.add(sprite);
      const angle = (k / 6) * Math.PI * 2;
      bursts.push({ sprite, rel: 0, lateral: 0, velocity: new THREE.Vector3(Math.cos(angle) * 3, 4 + Math.random() * 2, Math.sin(angle) * 3), age: 0, owner: rival });
    }
  };

  // Mushrooms wait on the road at the exact spot the kart passes when each boost begins.
  const mushrooms = Array.from({ length: 6 }, () => {
    const mushroom = createMushroom(materials, geometries);
    mushroom.visible = false;
    parent.add(mushroom);
    return mushroom;
  });
  const eaten = new Set<number>();
  const pops: { at: THREE.Vector3; age: number; sprite: THREE.Sprite }[] = [];
  const popMaterial = additive(flameMap, 0xffe0e0);

  // Drift sparks from the rear wheels.
  const SPARKS = 160;
  const sparkPositions = new Float32Array(SPARKS * 3);
  const sparkColors = new Float32Array(SPARKS * 3);
  const sparkGeometry = new THREE.BufferGeometry();
  sparkGeometry.setAttribute("position", new THREE.BufferAttribute(sparkPositions, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeometry.setAttribute("color", new THREE.BufferAttribute(sparkColors, 3).setUsage(THREE.DynamicDrawUsage));
  geometries.push(sparkGeometry);
  const sparkMaterial = new THREE.PointsMaterial({
    size: 0.35,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    map: flameMap,
  });
  materials.push(sparkMaterial);
  const sparkPoints = new THREE.Points(sparkGeometry, sparkMaterial);
  sparkPoints.frustumCulled = false;
  parent.add(sparkPoints);
  const sparks = Array.from({ length: SPARKS }, () => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3(), age: 1, life: 1, color: new THREE.Color() }));
  let nextSpark = 0;
  let driftTime = 0;

  // Speed lines rush past the lens while boosting.
  const LINES = 140;
  const linePositions = new Float32Array(LINES * 6);
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3).setUsage(THREE.DynamicDrawUsage));
  geometries.push(lineGeometry);
  const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  materials.push(lineMaterial);
  const speedLines = new THREE.LineSegments(lineGeometry, lineMaterial);
  speedLines.frustumCulled = false;
  camera.add(speedLines);
  const lines = Array.from({ length: LINES }, () => ({
    angle: Math.random() * Math.PI * 2,
    radius: 2.5 + Math.random() * 5,
    z: -4 - Math.random() * 60,
    length: 3 + Math.random() * 6,
  }));

  // The race position, big in the corner as in the game.
  const badge = document.createElement("div");
  Object.assign(badge.style, {
    position: "absolute",
    right: "4%",
    bottom: "5%",
    zIndex: "5",
    pointerEvents: "none",
    font: "italic 900 clamp(28px, 9vh, 110px)/1 'Arial Black', Arial, sans-serif",
    color: "#ffd84a",
    letterSpacing: "0.02em",
    webkitTextStroke: "0.06em #2a1300",
    paintOrder: "stroke fill",
    textShadow: "0 0.08em 0 #b04a00",
    transition: "transform 160ms ease-out",
  } satisfies Partial<CSSStyleDeclaration>);
  host.after(badge);
  let shownPlace = -1;

  const frame = newFrame();
  const ahead = newFrame();
  const basis = new THREE.Matrix4();
  const back = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  /** Pose an object on the road at a distance and sideways offset, facing down the road. */
  const poseOnRoad = (object: THREE.Object3D, course: Course, distance: number, lateral: number, lift = 0) => {
    courseFrame(course, indexAtDistance(course, distance), frame);
    object.position.copy(frame.point).addScaledVector(frame.right, lateral).addScaledVector(frame.up, lift);
    basis.makeBasis(frame.right, frame.up, back.copy(frame.tangent).negate());
    object.quaternion.setFromRotationMatrix(basis);
    return frame;
  };

  const spinWheels = (kart: Kart, rolled: number) => {
    for (const wheel of kart.wheels) wheel.rotation.x = -rolled / 0.4;
  };

  let rolled = 0;
  let starHue = 0;
  let shotTimer = 4;
  const state = { boost: 0, star: 0, place: 1 };

  return {
    state,
    /** The player smashed an item box: a shell is on its way. */
    smashed(time: number) {
      pendingShots.push(time + 0.35);
    },
    reset() {
      eaten.clear();
      for (const shell of shells) shell.mesh.removeFromParent();
      shells.length = 0;
    },
    update(input: RaceInput) {
      const { course, songTime, time, dt, distance, steer } = input;
      const index = indexAtDistance(course, distance);
      const i = Math.min(course.count - 1, Math.floor(songTime * COURSE_RATE));
      const boost = course.boost[i] ?? 0;
      const star = course.stars.some((s) => songTime >= s.start && songTime < s.end) ? 1 : 0;
      state.boost += (boost - state.boost) * (1 - Math.exp(-dt * 8));
      state.star += (star - state.star) * (1 - Math.exp(-dt * 6));
      const speed = ((course.distance[Math.min(course.count - 1, i + 1)] ?? 0) - (course.distance[i] ?? 0)) * COURSE_RATE;

      // How hard the road is turning just ahead decides the drift.
      courseFrame(course, index, frame);
      courseFrame(course, Math.min(course.count - 1, index + 10), ahead);
      const turn = tmp.crossVectors(frame.tangent, ahead.tangent).dot(frame.up);
      const drifting = Math.abs(turn) > 0.05;
      driftTime = drifting ? driftTime + dt : 0;

      // The player's kart.
      rolled += speed * dt;
      poseOnRoad(player.group, course, distance, steer, 0);
      player.body.rotation.y = THREE.MathUtils.clamp(turn * 3, -0.45, 0.45);
      player.body.position.y = Math.abs(Math.sin(time * 18)) * 0.03 + (state.star > 0.5 ? Math.abs(Math.sin(time * 9)) * 0.2 : 0);
      spinWheels(player, rolled);
      starHue = (starHue + dt * 2.5) % 1;
      player.paint.emissive.setHSL(starHue, 1, 0.5).multiplyScalar(state.star * 0.9);
      const flameSize = Math.max(state.boost, drifting && driftTime > 0.6 ? 0.35 : 0);
      for (const sprite of player.flames) {
        sprite.visible = flameSize > 0.05;
        const flicker = 0.8 + Math.random() * 0.4;
        sprite.scale.set(0.7 * flicker * (0.5 + flameSize), 1.6 * flicker * (0.4 + flameSize), 1);
      }

      // Sparks fly from the back wheels in a drift: blue at first, orange once held.
      if (drifting) {
        const orange = driftTime > 1;
        for (let n = 0; n < 4; n++) {
          const spark = sparks[nextSpark]!;
          nextSpark = (nextSpark + 1) % SPARKS;
          const side = n % 2 ? 1 : -1;
          spark.position.copy(player.group.position).addScaledVector(frame.right, side * 1).addScaledVector(frame.up, 0.2).addScaledVector(frame.tangent, -1.3);
          spark.velocity.copy(frame.tangent).multiplyScalar(speed * 0.8).addScaledVector(frame.right, side * (2 + Math.random() * 3)).addScaledVector(frame.up, 2 + Math.random() * 3);
          spark.age = 0;
          spark.life = 0.25 + Math.random() * 0.2;
          spark.color.set(orange ? 0xff8a20 : 0x40a8ff);
        }
      }
      sparks.forEach((spark, k) => {
        spark.age += dt;
        const alive = spark.age < spark.life;
        if (alive) spark.position.addScaledVector(spark.velocity, dt);
        (alive ? spark.position : tmp.set(0, -1e5, 0)).toArray(sparkPositions, k * 3);
        spark.color.clone().multiplyScalar(alive ? 1 - spark.age / spark.life : 0).toArray(sparkColors, k * 3);
      });
      sparkGeometry.attributes.position!.needsUpdate = true;
      sparkGeometry.attributes.color!.needsUpdate = true;

      // Rivals jostle around the player; a boost or star leaves them behind, and they catch up again.
      const gain = state.boost * 22 + state.star * 6;
      for (const rival of rivals) {
        let pace = 3 * Math.sin(time * 0.31 + rival.seed) + 2.5 * Math.sin(time * 0.73 + rival.seed * 2) - gain;
        if (rival.offset > 110) pace -= 6;
        if (rival.offset < -45) pace += 9;
        if (rival.spin > 0) pace -= 20;
        rival.offset += pace * dt;
        let lane = Math.sin(time * 0.4 + rival.seed * 3) * 5;
        // Keep clear of the player, unless the player has star power and bowls them aside.
        if (Math.abs(rival.offset) < 5 && Math.abs(lane - steer) < 2.6) {
          if (state.star > 0.5 && rival.spin <= 0 && rival.bump <= 0) {
            spinOut(rival);
            rival.bump = 2;
          }
          lane = steer + Math.sign(lane - steer || 1) * 3;
        }
        rival.lateral += (lane - rival.lateral) * (1 - Math.exp(-dt * 2));
        rival.spin = Math.max(0, rival.spin - dt);
        rival.bump = Math.max(0, rival.bump - dt);
        const at = distance + rival.offset;
        rival.kart.group.visible = at > 0 && at < (course.distance[course.count - 1] ?? 0) && rival.offset > -5;
        if (!rival.kart.group.visible) continue;
        poseOnRoad(rival.kart.group, course, at, rival.lateral, 0);
        const spinning = rival.spin > 0;
        rival.kart.body.rotation.y = spinning ? (1 - rival.spin / 1.1) * Math.PI * 4 : Math.sin(time * 2 + rival.seed) * 0.08;
        rival.kart.body.position.y = spinning ? Math.sin((rival.spin / 1.1) * Math.PI) * 0.8 : Math.abs(Math.sin(time * 17 + rival.seed)) * 0.03;
        spinWheels(rival.kart, rolled + rival.seed);
        for (const sprite of rival.kart.flames) sprite.visible = false;
      }

      // Shells: the player's, launched just after a box breaks, and rivals' at each other.
      while (pendingShots.length && pendingShots[0]! <= time) {
        pendingShots.shift();
        throwShell(0, steer);
      }
      shotTimer -= dt;
      if (shotTimer <= 0) {
        shotTimer = 5 + Math.random() * 5;
        const thrower = rivals.filter((r) => r.offset > 0 && r.offset < 60 && r.spin <= 0)[0];
        if (thrower) throwShell(thrower.offset, thrower.lateral);
      }
      for (let k = shells.length - 1; k >= 0; k--) {
        const shell = shells[k]!;
        shell.age += dt;
        shell.rel += 48 * dt;
        if (shell.target) {
          const remaining = shell.target.offset - shell.rel;
          shell.lateral += (shell.target.lateral - shell.lateral) * (1 - Math.exp(-dt * (remaining < 20 ? 8 : 2)));
          if (remaining <= 0.8) {
            spinOut(shell.target);
            shell.mesh.removeFromParent();
            shells.splice(k, 1);
            continue;
          }
        }
        if (shell.age > 4) {
          shell.mesh.removeFromParent();
          shells.splice(k, 1);
          continue;
        }
        poseOnRoad(shell.mesh, course, distance + shell.rel, shell.lateral, 0.15);
        shell.mesh.rotateY(time * 14);
      }
      for (let k = bursts.length - 1; k >= 0; k--) {
        const burst = bursts[k]!;
        burst.age += dt;
        if (burst.age > 0.9) {
          burst.sprite.removeFromParent();
          bursts.splice(k, 1);
          continue;
        }
        const owner = burst.owner.kart.group;
        burst.sprite.position.copy(owner.position).add(tmp.copy(burst.velocity).multiplyScalar(burst.age)).addScaledVector(frame.up, 1.5 - burst.age * burst.age * 3);
        burst.sprite.scale.setScalar(0.9 * (1 - burst.age / 0.9) + 0.2);
      }

      // Mushrooms: grabbed exactly as each boost kicks in.
      let shown = 0;
      course.mushrooms.forEach((at, k) => {
        const sample = Math.min(course.count - 1, Math.round(at * COURSE_RATE));
        const where = (course.distance[sample] ?? 0) + KART_LEAD;
        if (eaten.has(k)) return;
        if (where < distance) {
          eaten.add(k);
          const sprite = new THREE.Sprite(popMaterial);
          poseOnRoad(sprite, course, where, steer, 1.2);
          parent.add(sprite);
          pops.push({ at: sprite.position.clone(), age: 0, sprite });
          return;
        }
        if (where - distance > 420 || shown >= mushrooms.length) return;
        const mushroom = mushrooms[shown++]!;
        mushroom.visible = true;
        poseOnRoad(mushroom, course, where, 0, 0.1 + Math.abs(Math.sin(time * 4 + k)) * 0.3);
        mushroom.rotateY(time * 1.5);
      });
      for (let k = shown; k < mushrooms.length; k++) mushrooms[k]!.visible = false;
      for (let k = pops.length - 1; k >= 0; k--) {
        const pop = pops[k]!;
        pop.age += dt;
        pop.sprite.scale.setScalar(1 + pop.age * 14);
        if (pop.age > 0.3) {
          pop.sprite.removeFromParent();
          pops.splice(k, 1);
        }
      }

      // Speed lines and the camera's widening view are both driven by the boost.
      lineMaterial.opacity = Math.min(0.7, state.boost * 0.7 + state.star * 0.25);
      lines.forEach((line, k) => {
        line.z += (speed * 1.2 + 20) * dt;
        if (line.z > -2) line.z -= 64;
        const x = Math.cos(line.angle) * line.radius,
          y = Math.sin(line.angle) * line.radius * 0.6;
        linePositions.set([x, y, line.z, x, y, line.z - line.length], k * 6);
      });
      lineGeometry.attributes.position!.needsUpdate = true;

      // Place: one plus every rival ahead.
      const place = 1 + rivals.filter((r) => r.offset > 0).length;
      state.place = place;
      if (place !== shownPlace) {
        shownPlace = place;
        badge.textContent = ORDINAL[place - 1] ?? `${place}TH`;
        badge.style.transform = "scale(1.35)";
        setTimeout(() => (badge.style.transform = "scale(1)"), 160);
      }
    },
    dispose() {
      badge.remove();
      speedLines.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
      player.group.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose());
      for (const rival of rivals) rival.kart.group.traverse((o) => o instanceof THREE.Mesh && o.geometry.dispose());
    },
  };
}
