import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { DEFAULT_VISUAL_LOOK, type VisualLook } from "../../../dj-monitor/src/visual-presets.js";
import { createMusicFollower } from "../music/follow.js";
import { sectionAt, type SongMap, type Style } from "../music/song-map.js";
import type { MusicLane, SceneEngine } from "../scenes.js";

/** Path width and tile length, in metres; every tile sits at a multiple of TILE along the path. */
const TILE = 4;
const LANE = 1.2;
const RATE = 30;
const EXTRA_SECONDS = 30;
/** Running speed per style, metres per second. */
const SPEED: Record<Style, number> = { break: 9, vocal: 11, groove: 12.5, build: 14, drop: 16 };
const CHUNK = 8;
const AHEAD = 200;
const BEHIND = 24;
const WALL_DEPTH = 46;
/** Forward along the path for each direction, turning right one step at a time. */
const DIRS = [
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(-1, 0, 0),
];
const yawOf = (dir: number) => -dir * (Math.PI / 2);

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function seeded(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// The course: where the path runs, turns, climbs and drops, and what is on it, all from the song.

type Segment = { start: number; length: number; dir: number; origin: THREE.Vector3 };
type ObstacleKind = "gap" | "root" | "arch";
type Layout = {
  distance: Float32Array;
  segments: Segment[];
  ramps: { s: number; length: number; rise: number }[];
  obstacles: Map<number, ObstacleKind>;
  coins: { s: number; lane: number }[];
};

function buildLayout(song: SongMap, scale: number): Layout {
  const count = Math.ceil((song.duration + EXTRA_SECONDS) * RATE);
  const distance = new Float32Array(count);
  const dt = 1 / RATE;
  let speed = SPEED.vocal * scale,
    s = 0;
  for (let i = 0; i < count; i++) {
    const t = i * dt;
    const style = t < song.duration ? (sectionAt(song, t)?.style ?? "vocal") : "vocal";
    speed += (SPEED[style] * scale - speed) * (1 - Math.exp(-dt * 1.2));
    distance[i] = s;
    s += speed * dt;
  }
  const total = s;
  const at = (t: number) => {
    const f = THREE.MathUtils.clamp(t * RATE, 0, count - 1.001);
    const i = Math.floor(f);
    return distance[i]! + (distance[i + 1]! - distance[i]!) * (f - i);
  };
  const bars = song.bars.length ? song.bars : [0];
  const barsIn = (from: number, to: number) => bars.filter((b) => b >= from && b < to);
  const snap = (value: number) => Math.round(value / TILE) * TILE;

  // Corners: at each change of style (drops plunge down stairs instead), and every 8 bars.
  const cornerTimes: number[] = [];
  song.sections.forEach((section, i) => {
    if (i > 0 && section.style !== "drop") cornerTimes.push(section.start);
    const inside = barsIn(section.start, section.end);
    for (let k = 8; k < inside.length - 3; k += 8) cornerTimes.push(inside[k]!);
  });
  for (let t = song.duration + 8; t < song.duration + EXTRA_SECONDS; t += 10) cornerTimes.push(t);
  const corners: number[] = [];
  for (const t of cornerTimes.sort((a, b) => a - b)) {
    const c = snap(at(t));
    if (c - (corners.at(-1) ?? 0) >= TILE * 6) corners.push(c);
  }
  const segments: Segment[] = [];
  let dir = 0,
    side = 1;
  const origin = new THREE.Vector3();
  [0, ...corners].forEach((start, k, all) => {
    const end = all[k + 1] ?? snap(total) + TILE * 40;
    segments.push({ start, length: end - start, dir, origin: origin.clone() });
    origin.addScaledVector(DIRS[dir]!, end - start);
    // Alternating sides makes a zigzag that can never run back into itself.
    dir = (dir + side + 4) % 4;
    side = -side;
  });
  const segmentAt = (value: number) => {
    let low = 0,
      high = segments.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (segments[mid]!.start <= value) low = mid;
      else high = mid - 1;
    }
    return segments[low]!;
  };
  /** True when the whole stretch lies on one straight, clear of the corner tiles. */
  const straight = (from: number, to: number) => {
    const segment = segmentAt(from);
    return from >= segment.start + TILE && to <= segment.start + segment.length - TILE;
  };

  const ramps: Layout["ramps"] = [];
  const obstacles = new Map<number, ObstacleKind>();
  const onRamp = (value: number) => ramps.some((r) => value >= r.s - TILE && value <= r.s + r.length + TILE);
  const place = (value: number, kind: ObstacleKind) => {
    const tile = snap(value);
    if (!straight(tile - TILE, tile + TILE) || onRamp(tile)) return false;
    for (const other of obstacles.keys()) if (Math.abs(other - tile) < TILE * 4) return false;
    obstacles.set(tile, kind);
    return true;
  };
  // Ramps run between tile edges so every tile is wholly flat or wholly sloped.
  const ramp = (from: number, length: number, rise: number) => {
    const start = snap(from) + TILE / 2;
    const tiles = Math.max(1, Math.round(length / TILE));
    if (straight(start, start + tiles * TILE)) ramps.push({ s: start, length: tiles * TILE, rise });
  };
  for (const section of song.sections) {
    const from = at(section.start),
      to = at(section.end);
    if (section.style === "build") ramp(from + TILE * 2, Math.min(to - from - TILE * 4, TILE * 5), 3);
    if (section.style === "drop") ramp(from, TILE * 2, -3.5);
  }
  for (const section of song.sections) {
    const inside = barsIn(section.start, section.end);
    if (section.style === "build") place(at(section.end) - TILE * 2, "arch");
    if (section.style === "vocal" || section.style === "break") place(at(section.start) + TILE * 3, "arch");
    if (section.style === "groove")
      for (let k = 2; k < inside.length; k += 4) place(at(inside[k]!), "root");
    if (section.style === "drop")
      for (let k = 4; k < inside.length; k += 8) place(at(inside[k]!), "gap");
  }
  // Irregular moments in the rhythm open a gap to leap.
  for (const t of song.swirls) place(at(t), "gap");

  // Lines of coins weave between lanes on the busier sections.
  const coins: Layout["coins"] = [];
  for (const section of song.sections) {
    if (section.style === "break") continue;
    const inside = barsIn(section.start, section.end);
    for (let k = 0; k < inside.length; k += 2) {
      const from = snap(at(inside[k]!)) + TILE / 2;
      const to = from + 14;
      if (!straight(from, to)) continue;
      if ([...obstacles.keys()].some((o) => o > from - 6 && o < to + 6)) continue;
      const lane = Math.floor(hash(from) * 3) - 1;
      for (let c = 0; c < 8; c++) coins.push({ s: from + c * 2, lane });
    }
  }
  return { distance, segments, ramps, obstacles, coins };
}

function heightAt(layout: Layout, s: number) {
  let h = 0;
  for (const r of layout.ramps) h += r.rise * THREE.MathUtils.clamp((s - r.s) / r.length, 0, 1);
  return h;
}

function segmentAt(layout: Layout, s: number) {
  const segments = layout.segments;
  let low = 0,
    high = segments.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (segments[mid]!.start <= s) low = mid;
    else high = mid - 1;
  }
  return segments[low]!;
}

/** Where the centre of the path is at distance `s`, and which way it runs. */
function poseAt(layout: Layout, s: number, out: THREE.Vector3) {
  const segment = segmentAt(layout, Math.max(0, s));
  out.copy(segment.origin).addScaledVector(DIRS[segment.dir]!, s - segment.start);
  out.y = heightAt(layout, s);
  return segment;
}

function distanceAt(layout: Layout, time: number) {
  const d = layout.distance;
  const f = THREE.MathUtils.clamp(time * RATE, 0, d.length - 1.001);
  const i = Math.floor(f);
  return d[i]! + (d[i + 1]! - d[i]!) * (f - i);
}

// ---------------------------------------------------------------------------------------------
// Materials and models, all procedural.

function canvasTexture(width: number, height: number, paint: (c: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  paint(canvas.getContext("2d")!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

/** Worn sandstone paving with moss in the joints. */
function pathTexture() {
  return canvasTexture(512, 512, (c) => {
    const random = seeded(7);
    c.fillStyle = "#6d5a3f";
    c.fillRect(0, 0, 512, 512);
    const rows = [0, 120, 250, 380, 512];
    for (let r = 0; r < rows.length - 1; r++) {
      let x = r % 2 ? -60 : 0;
      while (x < 512) {
        const w = 120 + random() * 110;
        const tone = 150 + random() * 45;
        c.fillStyle = `rgb(${tone + 22}, ${tone}, ${tone - 42})`;
        c.fillRect(x + 4, rows[r]! + 4, w - 8, rows[r + 1]! - rows[r]! - 8);
        for (let k = 0; k < 260; k++) {
          c.fillStyle = `rgba(${random() > 0.5 ? "60,45,25" : "255,240,205"},${random() * 0.12})`;
          c.fillRect(x + random() * w, rows[r]! + random() * 120, 2 + random() * 10, 1 + random() * 4);
        }
        x += w;
      }
    }
    for (let k = 0; k < 90; k++) {
      c.fillStyle = `rgba(${70 + random() * 40},${110 + random() * 40},${40 + random() * 20},${0.25 + random() * 0.4})`;
      c.beginPath();
      c.ellipse(random() * 512, rows[Math.floor(random() * 4)]! + 2, 8 + random() * 30, 3 + random() * 6, 0, 0, Math.PI * 2);
      c.fill();
    }
    c.strokeStyle = "rgba(40,28,15,0.55)";
    c.lineWidth = 2;
    for (let k = 0; k < 14; k++) {
      let x = random() * 512,
        y = random() * 512;
      c.beginPath();
      c.moveTo(x, y);
      for (let j = 0; j < 5; j++) c.lineTo((x += (random() - 0.5) * 50), (y += (random() - 0.5) * 50));
      c.stroke();
    }
  });
}

/** Big weathered blocks with vines of moss, for the walls the path stands on. */
function wallTexture() {
  return canvasTexture(256, 512, (c) => {
    const random = seeded(19);
    c.fillStyle = "#3e3328";
    c.fillRect(0, 0, 256, 512);
    for (let y = 0; y < 512; y += 64)
      for (let x = (y / 64) % 2 ? -64 : 0; x < 256; x += 128) {
        const tone = 95 + random() * 40;
        c.fillStyle = `rgb(${tone + 12}, ${tone}, ${tone - 20})`;
        c.fillRect(x + 3, y + 3, 122, 58);
      }
    for (let k = 0; k < 1800; k++) {
      c.fillStyle = `rgba(${random() > 0.5 ? "30,22,12" : "220,205,170"},${random() * 0.15})`;
      c.fillRect(random() * 256, random() * 512, 1 + random() * 5, 1 + random() * 3);
    }
    for (let k = 0; k < 9; k++) {
      let x = random() * 256;
      c.strokeStyle = `rgba(${50 + random() * 30},${100 + random() * 50},${35},0.7)`;
      c.lineWidth = 3 + random() * 5;
      c.beginPath();
      c.moveTo(x, 0);
      for (let y = 0; y < 512; y += 30) c.lineTo((x += (random() - 0.5) * 18), y);
      c.stroke();
    }
  });
}

function barkTexture() {
  return canvasTexture(128, 256, (c) => {
    const random = seeded(31);
    c.fillStyle = "#4a3624";
    c.fillRect(0, 0, 128, 256);
    for (let k = 0; k < 70; k++) {
      const x = random() * 128;
      c.strokeStyle = `rgba(${random() > 0.5 ? "25,16,8" : "130,105,75"},${0.3 + random() * 0.4})`;
      c.lineWidth = 1 + random() * 4;
      c.beginPath();
      c.moveTo(x, 0);
      c.bezierCurveTo(x + (random() - 0.5) * 20, 90, x + (random() - 0.5) * 20, 170, x + (random() - 0.5) * 16, 256);
      c.stroke();
    }
  });
}

/** A cluster of broad jungle leaves on a transparent card. */
function leafTexture() {
  const texture = canvasTexture(256, 256, (c) => {
    const random = seeded(43);
    c.clearRect(0, 0, 256, 256);
    for (let k = 0; k < 9; k++) {
      const x = 50 + random() * 156,
        y = 50 + random() * 156;
      const angle = random() * Math.PI * 2;
      const length = 55 + random() * 45;
      c.save();
      c.translate(x, y);
      c.rotate(angle);
      const g = 90 + random() * 80;
      c.fillStyle = `rgb(${30 + random() * 40}, ${g}, ${25 + random() * 25})`;
      c.beginPath();
      c.moveTo(0, 0);
      c.quadraticCurveTo(length * 0.5, -length * 0.32, length, 0);
      c.quadraticCurveTo(length * 0.5, length * 0.32, 0, 0);
      c.fill();
      c.strokeStyle = "rgba(200,230,140,0.35)";
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(length * 0.95, 0);
      c.stroke();
      c.restore();
    }
  });
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function noise3(x: number, y: number, z: number) {
  return (
    Math.sin(x * 1.7 + Math.sin(z * 1.3)) * Math.cos(y * 1.9 + Math.sin(x * 0.7)) * 0.5 +
    Math.sin(z * 2.3 + y * 1.1) * 0.25
  );
}

/** A lumpy, organic blob of foliage with varied greens baked into its vertices. */
function foliageBlob(radius: number, random: () => number) {
  // Welded vertices give smooth, rounded shading instead of facets.
  const sphere = new THREE.IcosahedronGeometry(radius, 4);
  sphere.deleteAttribute("normal");
  sphere.deleteAttribute("uv");
  const geometry = mergeVertices(sphere);
  sphere.dispose();
  const position = geometry.attributes.position!;
  const colors = new Float32Array(position.count * 3);
  const offset = random() * 10;
  const v = new THREE.Vector3();
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const n = noise3(v.x * 0.9 + offset, v.y * 0.9, v.z * 0.9);
    v.multiplyScalar(1 + n * 0.28);
    if (v.y < 0) v.y *= 0.7;
    position.setXYZ(i, v.x, v.y, v.z);
    color.setHSL(
      0.25 + n * 0.06 + random() * 0.03,
      0.6 + random() * 0.15,
      0.2 + (v.y / radius) * 0.09 + n * 0.05 + random() * 0.03,
      THREE.SRGBColorSpace,
    );
    color.toArray(colors, i * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Leaf cards scattered over a canopy so its silhouette reads as leaves, not a ball. */
function leafCards(centres: { centre: THREE.Vector3; radius: number }[], count: number, random: () => number) {
  const cards: THREE.BufferGeometry[] = [];
  const card = new THREE.PlaneGeometry(2.2, 2.2);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < count; i++) {
    const blob = centres[Math.floor(random() * centres.length)]!;
    const direction = new THREE.Vector3().randomDirection();
    if (direction.y < -0.4) direction.y *= -0.5;
    const p = blob.centre.clone().addScaledVector(direction, blob.radius * (0.85 + random() * 0.35));
    e.set(random() * Math.PI, random() * Math.PI * 2, random() * Math.PI);
    m.compose(p, q.setFromEuler(e), new THREE.Vector3().setScalar(0.8 + random() * 0.8));
    cards.push(card.clone().applyMatrix4(m));
  }
  return mergeGeometries(cards)!;
}

type TreeModel = { wood: THREE.BufferGeometry; canopy: THREE.BufferGeometry; leaves: THREE.BufferGeometry };

/** A tall jungle tree rising from far below, with a spreading canopy and hanging vines. */
function treeModel(seed: number, trunk: boolean): TreeModel {
  const random = seeded(seed);
  const height = trunk ? 34 + random() * 10 : 0;
  const wood: THREE.BufferGeometry[] = [];
  if (trunk) {
    const stem = new THREE.CylinderGeometry(0.55, 1.3, height, 12, 16, true);
    const position = stem.attributes.position!;
    const v = new THREE.Vector3();
    const lean = (random() - 0.5) * 3;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i);
      const t = (v.y + height / 2) / height;
      const angle = Math.atan2(v.z, v.x);
      const ridge = 1 + Math.sin(angle * 5 + t * 3) * 0.08;
      position.setXYZ(i, v.x * ridge + lean * t * t + Math.sin(t * 6 + seed) * 0.4, v.y + height / 2, v.z * ridge);
    }
    stem.computeVertexNormals();
    wood.push(stem);
  }
  const top = new THREE.Vector3(0, height, 0);
  const blobs: { centre: THREE.Vector3; radius: number }[] = [];
  const count = 5 + Math.floor(random() * 4);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + random();
    const reach = i === 0 ? 0 : 2.5 + random() * 3.5;
    const radius = 2.4 + random() * 1.8;
    const centre = top
      .clone()
      .add(new THREE.Vector3(Math.cos(angle) * reach, 1 + random() * 2.5 - reach * 0.25, Math.sin(angle) * reach));
    blobs.push({ centre, radius });
    if (trunk && i > 0) {
      const dir = centre.clone().sub(top).normalize();
      const b = new THREE.CylinderGeometry(0.12, 0.32, reach + 1, 6);
      b.translate(0, (reach + 1) / 2, 0);
      b.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
      b.translate(top.x, top.y - 1, top.z);
      wood.push(b);
    }
  }
  const canopy: THREE.BufferGeometry[] = blobs.map(({ centre, radius }) =>
    foliageBlob(radius, random).translate(centre.x, centre.y, centre.z),
  );
  // Vines dangle from the canopy's edge.
  const vineCount = trunk ? 3 + Math.floor(random() * 3) : 0;
  for (let i = 0; i < vineCount; i++) {
    const blob = blobs[1 + Math.floor(random() * (blobs.length - 1))]!;
    const start = blob.centre.clone().add(new THREE.Vector3((random() - 0.5) * 2, -blob.radius * 0.6, (random() - 0.5) * 2));
    const length = 5 + random() * 9;
    const points = Array.from({ length: 6 }, (_, k) =>
      start.clone().add(new THREE.Vector3(Math.sin(k + i) * 0.4, (-k / 5) * length, Math.cos(k * 1.3 + i) * 0.4)),
    );
    const vine = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 16, 0.07, 5);
    const colors = new Float32Array(vine.attributes.position!.count * 3);
    for (let k = 0; k < colors.length; k += 3) colors.set([0.03, 0.07 + random() * 0.03, 0.015], k);
    vine.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    vine.deleteAttribute("uv");
    canopy.push(vine);
  }
  return {
    wood: wood.length ? mergeGeometries(wood)! : new THREE.BufferGeometry(),
    canopy: mergeGeometries(canopy)!,
    leaves: leafCards(blobs, trunk ? 150 : 90, random),
  };
}

type Limb = { pivot: THREE.Group; joint: THREE.Group };

/** An explorer in a fedora, khaki shirt and boots, built from rounded parts. */
function createRunner() {
  const material = (color: number, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness });
  const skin = material(0xd49a72, 0.6);
  const shirt = material(0xc9ab72);
  const pants = material(0x5d4630);
  const boots = material(0x2e1d10);
  const hatMaterial = material(0x6b4423, 0.9);
  const band = material(0x24160b);
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const hips = new THREE.Group();
  hips.position.y = 0.98;
  body.add(hips);
  const mesh = (geometry: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, y = 0, x = 0, z = 0) => {
    const part = new THREE.Mesh(geometry, m);
    part.position.set(x, y, z);
    part.castShadow = true;
    parent.add(part);
    return part;
  };
  const torso = new THREE.Group();
  hips.add(torso);
  mesh(new THREE.CapsuleGeometry(0.17, 0.12, 6, 12), pants, hips, 0).scale.set(1.25, 1, 0.9);
  const chest = mesh(new THREE.CapsuleGeometry(0.21, 0.32, 6, 14), shirt, torso, 0.36);
  chest.scale.set(1.15, 1, 0.82);
  mesh(new THREE.BoxGeometry(0.36, 0.42, 0.18), material(0x5b3f22), torso, 0.4, 0, 0.2);
  mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 10), skin, torso, 0.72);
  const head = new THREE.Group();
  head.position.y = 0.88;
  torso.add(head);
  mesh(new THREE.SphereGeometry(0.15, 20, 16), skin, head).scale.set(0.95, 1.08, 1);
  mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.025, 28), hatMaterial, head, 0.1);
  mesh(new THREE.CylinderGeometry(0.13, 0.155, 0.17, 20), hatMaterial, head, 0.19);
  mesh(new THREE.CylinderGeometry(0.157, 0.157, 0.04, 20), band, head, 0.13);
  const limb = (parent: THREE.Object3D, x: number, y: number, upper: number, lower: number, radius: number, a: THREE.Material, b: THREE.Material, end: THREE.Mesh | null): Limb => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    parent.add(pivot);
    mesh(new THREE.CapsuleGeometry(radius, upper, 4, 10), a, pivot, -upper / 2 - radius * 0.5);
    const joint = new THREE.Group();
    joint.position.y = -upper - radius;
    pivot.add(joint);
    mesh(new THREE.CapsuleGeometry(radius * 0.9, lower, 4, 10), b, joint, -lower / 2 - radius * 0.4);
    if (end) {
      end.position.y = -lower - radius * 1.2;
      end.castShadow = true;
      joint.add(end);
    }
    return { pivot, joint };
  };
  const legs = [-1, 1].map((side) => {
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.12, 0.28), boots);
    boot.geometry.translate(0, 0, -0.05);
    return limb(hips, side * 0.11, -0.02, 0.32, 0.3, 0.085, pants, pants, boot);
  });
  const arms = [-1, 1].map((side) =>
    limb(torso, side * 0.28, 0.6, 0.22, 0.2, 0.06, shirt, skin, new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 8), skin)),
  );
  return { root, body, hips, torso, head, legs, arms };
}

/** A demon monkey: dark fur, long arms, glowing eyes. */
function createMonkey(seed: number) {
  const random = seeded(seed);
  const fur = new THREE.MeshStandardMaterial({ color: 0x2b1d1c, roughness: 1 });
  const face = new THREE.MeshStandardMaterial({ color: 0x7a5546, roughness: 0.9 });
  const eye = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 0.4, 0.15) });
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = 0.75;
  root.add(body);
  const furry = (radius: number) => {
    const g = new THREE.IcosahedronGeometry(radius, 3);
    const p = g.attributes.position!;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      v.multiplyScalar(1 + (random() - 0.5) * 0.12);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
  };
  const add = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number) => {
    const part = new THREE.Mesh(g, m);
    part.position.set(x, y, z);
    part.castShadow = true;
    parent.add(part);
    return part;
  };
  add(furry(0.42), fur, body, 0, 0, 0).scale.set(1, 0.9, 1.25);
  const head = new THREE.Group();
  head.position.set(0, 0.38, -0.38);
  body.add(head);
  add(furry(0.27), fur, head, 0, 0, 0);
  add(new THREE.SphereGeometry(0.16, 14, 10), face, head, 0, -0.06, -0.18).scale.set(1.1, 0.8, 0.7);
  for (const side of [-1, 1]) {
    add(new THREE.SphereGeometry(0.045, 8, 6), eye, head, side * 0.09, 0.06, -0.24);
    add(new THREE.SphereGeometry(0.09, 10, 8), face, head, side * 0.26, 0.08, 0).scale.set(0.5, 1, 1);
  }
  const limbs = [-1, 1].flatMap((side) =>
    [-1, 1].map((end) => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.3, -0.05, end * 0.35);
      body.add(pivot);
      add(new THREE.CapsuleGeometry(0.08, end < 0 ? 0.6 : 0.45, 4, 8), fur, pivot, 0, -0.35, 0);
      return { pivot, front: end < 0 };
    }),
  );
  return { root, body, head, limbs, materials: [fur, face, eye] };
}

// ---------------------------------------------------------------------------------------------

/** An endless temple run through the jungle; its corners, stairs, jumps and gates follow the song. */
export async function createTempleRun(host: HTMLCanvasElement): Promise<SceneEngine> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.after(renderer.domElement);

  const scene = new THREE.Scene();
  const fog = new THREE.Fog(0xb7c9b4, 30, 210);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(68, 1, 0.1, 3000);
  const hemisphere = new THREE.HemisphereLight(0xd6ecff, 0x3d4a22, 1.5);
  scene.add(hemisphere);
  const sun = new THREE.DirectionalLight(0xffe0a8, 3.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 60 });
  sun.shadow.bias = -0.0008;
  scene.add(sun, sun.target);
  const sunDirection = new THREE.Vector3(-0.45, 0.62, -0.64).normalize();

  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(item: T) => (disposables.push(item), item);

  // Sky, distant mountains and a far-off temple follow the camera.
  const backdrop = new THREE.Group();
  scene.add(backdrop);
  const skyUniforms = {
    zenith: { value: new THREE.Color() },
    horizon: { value: new THREE.Color() },
    sunColor: { value: new THREE.Color() },
    sunDirection: { value: sunDirection },
    moon: { value: 0 },
  };
  backdrop.add(
    new THREE.Mesh(
      keep(new THREE.SphereGeometry(2500, 32, 24)),
      keep(
        new THREE.ShaderMaterial({
          side: THREE.BackSide,
          depthWrite: false,
          fog: false,
          uniforms: skyUniforms,
          vertexShader: /* glsl */ `varying vec3 vDir;
            void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
          fragmentShader: /* glsl */ `uniform vec3 zenith, horizon, sunColor, sunDirection; uniform float moon; varying vec3 vDir;
            void main() {
              float up = max(vDir.y, 0.);
              vec3 color = mix(horizon, zenith, pow(up, .55));
              float sunAmount = max(dot(vDir, sunDirection), 0.);
              color += sunColor * (pow(sunAmount, 900.) * 4. + pow(sunAmount, 12.) * .35);
              color = mix(color, vec3(1., .97, .9), smoothstep(.9994, .9997, dot(vDir, normalize(vec3(.5, .35, -.8)))) * moon);
              if (vDir.y < 0.) color = horizon;
              gl_FragColor = vec4(color, 1.);
            }`,
        }),
      ),
    ),
  );
  const farMaterial = keep(new THREE.MeshBasicMaterial({ color: 0x8aa3a0, fog: false }));
  const nearMaterial = keep(new THREE.MeshBasicMaterial({ color: 0x6f8c80, fog: false }));
  const random = seeded(99);
  for (let i = 0; i < 26; i++) {
    const angle = (i / 26) * Math.PI * 2 + random() * 0.2;
    const near = i % 2 === 0;
    const radius = near ? 700 : 1100;
    const height = (near ? 90 : 160) + random() * 140;
    const peak = new THREE.ConeGeometry(120 + random() * 120, height, 7, 4);
    const p = peak.attributes.position!;
    for (let k = 0; k < p.count; k++) p.setX(k, p.getX(k) * (1 + (random() - 0.5) * 0.3));
    const mountain = new THREE.Mesh(keep(peak), near ? nearMaterial : farMaterial);
    mountain.position.set(Math.cos(angle) * radius, height / 2 - 60, Math.sin(angle) * radius);
    backdrop.add(mountain);
  }
  // A great stepped temple looming in the haze.
  const temple = new THREE.Group();
  for (let k = 0; k < 7; k++) {
    const step = new THREE.Mesh(keep(new THREE.BoxGeometry(260 - k * 34, 26, 260 - k * 34)), nearMaterial);
    step.position.y = k * 26 - 50;
    temple.add(step);
  }
  const shrine = new THREE.Mesh(keep(new THREE.BoxGeometry(40, 40, 40)), nearMaterial);
  shrine.position.y = 7 * 26 - 30;
  temple.add(shrine);
  temple.position.set(-380, 0, -820);
  backdrop.add(temple);
  const abyss = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2)),
    keep(new THREE.MeshBasicMaterial({ color: 0x2c4430 })),
  );
  abyss.position.y = -70;
  backdrop.add(abyss);

  const pathMap = keep(pathTexture());
  const wallMap = keep(wallTexture());
  wallMap.repeat.set(1, 1);
  const barkMap = keep(barkTexture());
  barkMap.repeat.set(2, 6);
  const leafMap = keep(leafTexture());
  const pathMaterial = keep(new THREE.MeshStandardMaterial({ map: pathMap, bumpMap: pathMap, bumpScale: 1.5, roughness: 0.92 }));
  const wallMaterial = keep(new THREE.MeshStandardMaterial({ map: wallMap, color: 0xcfc0a8, roughness: 1 }));
  const carvedMaterial = keep(new THREE.MeshStandardMaterial({ map: wallMap, color: 0xa69276, roughness: 0.95 }));
  const barkMaterial = keep(new THREE.MeshStandardMaterial({ map: barkMap, color: 0xb59a80, roughness: 1 }));
  const canopyMaterial = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
  const leafMaterial = keep(
    new THREE.MeshStandardMaterial({ map: leafMap, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75 }),
  );

  // A tile is a tall block of masonry with the paving on top, so the path stands on sheer walls.
  const blockGeometry = keep(new THREE.BoxGeometry(TILE, WALL_DEPTH, TILE));
  blockGeometry.translate(0, -WALL_DEPTH / 2, 0);
  {
    const uv = blockGeometry.attributes.uv!;
    for (const face of [0, 1, 4, 5]) for (let k = face * 4; k < face * 4 + 4; k++) uv.setY(k, uv.getY(k) * (WALL_DEPTH / 8));
  }
  const blockMaterials = [wallMaterial, wallMaterial, pathMaterial, wallMaterial, wallMaterial, wallMaterial];
  const curbGeometry = keep(new THREE.BoxGeometry(0.4, 0.34, TILE));
  curbGeometry.translate(0, 0.17, 0);
  const capGeometry = keep(new THREE.BoxGeometry(0.5, 0.12, 0.5));
  const rootGeometry = keep(
    mergeGeometries([0, 1, 2].map((k) => {
      const r = seeded(200 + k);
      const points = Array.from({ length: 7 }, (_, i) => new THREE.Vector3(-2.6 + i * 0.87, 0.18 + Math.sin(i * 1.7 + k) * 0.18 + r() * 0.15, (r() - 0.5) * 0.7 + (k - 1) * 0.3));
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 30, 0.2 - k * 0.04, 7);
    }))!,
  );
  const pillarGeometry = keep(new THREE.BoxGeometry(0.8, 3.4, 0.9));
  pillarGeometry.translate(0, 1.7, 0);
  const lintelGeometry = keep(new THREE.BoxGeometry(5.8, 0.9, 1.1));
  const columnGeometry = keep(
    (() => {
      const g = new THREE.CylinderGeometry(0.75, 0.85, 30, 16, 1);
      const p = g.attributes.position!;
      for (let k = 0; k < p.count; k++) {
        const angle = Math.atan2(p.getZ(k), p.getX(k));
        const flute = 1 - 0.06 * Math.max(0, Math.cos(angle * 8));
        p.setX(k, p.getX(k) * flute);
        p.setZ(k, p.getZ(k) * flute);
      }
      g.translate(0, -15, 0);
      g.computeVertexNormals();
      return g;
    })(),
  );
  const coinGeometry = keep(new THREE.CylinderGeometry(0.3, 0.3, 0.07, 24).rotateX(Math.PI / 2));
  const coinMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0xffc533, metalness: 0.85, roughness: 0.25, emissive: 0x6a4300, emissiveIntensity: 0.6 }),
  );
  const flameTexture = keep(
    canvasTexture(64, 128, (c) => {
      const g = c.createRadialGradient(32, 90, 2, 32, 80, 50);
      g.addColorStop(0, "rgba(255,250,210,1)");
      g.addColorStop(0.3, "rgba(255,170,50,0.9)");
      g.addColorStop(1, "rgba(255,60,0,0)");
      c.fillStyle = g;
      c.beginPath();
      c.ellipse(32, 80, 26, 46, 0, 0, Math.PI * 2);
      c.fill();
    }),
  );
  const flameMaterial = keep(
    new THREE.SpriteMaterial({ map: flameTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
  );
  const sparkleMaterial = keep(
    new THREE.SpriteMaterial({ map: flameTexture, color: 0xffe9a0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
  );

  const trees = [11, 23, 37, 41, 59].map((seed) => treeModel(seed, true));
  const crowns = [71, 83, 97, 101].map((seed) => treeModel(seed, false));
  for (const model of [...trees, ...crowns]) {
    keep(model.wood);
    keep(model.canopy);
    keep(model.leaves);
  }

  // Everything on the course lives in its own space, so a new layout can continue seamlessly.
  const course = new THREE.Group();
  course.matrixAutoUpdate = false;
  scene.add(course);

  const runner = createRunner();
  course.add(runner.root);
  runner.root.traverse((o) => o instanceof THREE.Mesh && (keep(o.geometry), keep(o.material as THREE.Material)));
  const shadowBlob = new THREE.Mesh(
    keep(new THREE.CircleGeometry(0.55, 24).rotateX(-Math.PI / 2)),
    keep(new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false })),
  );
  course.add(shadowBlob);
  const monkeys = [0, 1, 2].map((i) => {
    const monkey = createMonkey(300 + i);
    course.add(monkey.root);
    monkey.root.traverse((o) => o instanceof THREE.Mesh && keep(o.geometry));
    monkey.materials.forEach((m) => keep(m));
    monkey.root.scale.setScalar(0.78);
    return { ...monkey, offset: (i - 1) * 1.45, lag: 2.6 + (i === 1 ? 1.4 : 0), phase: i * 1.9 };
  });

  // The world is built in chunks of tiles just ahead of the runner and dropped behind.
  type Chunk = { group: THREE.Group; coins: { mesh: THREE.Mesh; id: number; s: number }[]; flames: THREE.Sprite[] };
  const chunks = new Map<number, Chunk>();
  const collected = new Set<number>();
  const sparkles: { sprite: THREE.Sprite; age: number }[] = [];

  let layout: Layout;
  let layoutKey = "";
  let target: VisualLook = { ...DEFAULT_VISUAL_LOOK };
  const look = { ...target };

  const scratch = new THREE.Vector3();
  const buildChunk = (index: number): Chunk => {
    const group = new THREE.Group();
    const coins: Chunk["coins"] = [];
    const flames: THREE.Sprite[] = [];
    const place = (object: THREE.Object3D, s: number, x: number, y: number, dir: number, yaw = 0) => {
      poseAt(layout, s, scratch);
      const right = DIRS[(dir + 1) % 4]!;
      object.position.copy(scratch).addScaledVector(right, x);
      object.position.y += y;
      object.rotation.y = yawOf(dir) + yaw;
      group.add(object);
      return object;
    };
    for (let n = index * CHUNK; n < (index + 1) * CHUNK; n++) {
      const s = n * TILE;
      const segment = segmentAt(layout, s);
      const corner = s === segment.start && segment.start > 0;
      const dir = segment.dir;
      const obstacle = layout.obstacles.get(s);
      const h = heightAt(layout, s);
      const slope = Math.atan2(heightAt(layout, s + TILE / 2) - heightAt(layout, s - TILE / 2), TILE);

      if (obstacle !== "gap") {
        const tile = new THREE.Group();
        const block = new THREE.Mesh(blockGeometry, blockMaterials);
        block.receiveShadow = true;
        tile.add(block);
        // Curbs line the open sides; a corner keeps its back and its outer side walled.
        const curbs: [number, number][] = [];
        if (corner) {
          const previous = layout.segments[layout.segments.indexOf(segment) - 1]!;
          const turnedRight = (previous.dir + 1) % 4 === dir;
          curbs.push([turnedRight ? -1 : 1, 0], [0, 1]);
        } else curbs.push([-1, 0], [1, 0]);
        for (const [x, back] of curbs) {
          const curb = new THREE.Mesh(curbGeometry, carvedMaterial);
          curb.receiveShadow = true;
          if (back) {
            curb.rotation.y = Math.PI / 2;
            curb.position.set(0, 0, TILE / 2 - 0.2);
          } else curb.position.set(x * (TILE / 2 - 0.2), 0, 0);
          tile.add(curb);
        }
        place(tile, s, 0, 0, dir);
        tile.rotation.set(slope, yawOf(dir), 0, "YXZ");
      }

      if (obstacle === "root") place(new THREE.Mesh(rootGeometry, barkMaterial), s, 0, 0, dir).castShadow = true;
      if (obstacle === "arch") {
        const arch = new THREE.Group();
        for (const x of [-1, 1]) {
          const pillar = new THREE.Mesh(pillarGeometry, carvedMaterial);
          pillar.position.x = x * 2.55;
          arch.add(pillar);
        }
        const lintel = new THREE.Mesh(lintelGeometry, carvedMaterial);
        lintel.position.y = 2.15;
        arch.add(lintel);
        const crown = new THREE.Mesh(lintelGeometry, wallMaterial);
        crown.scale.set(0.7, 0.6, 0.8);
        crown.position.y = 2.85;
        arch.add(crown);
        for (const x of [-1.8, -0.3, 1.2]) {
          const vine = new THREE.Mesh(crowns[0]!.leaves, leafMaterial);
          vine.scale.setScalar(0.18);
          vine.position.set(x, 1.9, 0.6);
          arch.add(vine);
        }
        place(arch, s, 0, 0, dir);
      }

      // Scenery either side, chosen by the tile so it stays put.
      for (const side of [-1, 1]) {
        const k = n * 2 + (side > 0 ? 1 : 0);
        if (!corner && hash(k * 3.1) < 0.18 + look.density * 0.32) {
          const model = trees[Math.floor(hash(k * 5.7) * trees.length)]!;
          const tree = new THREE.Group();
          tree.add(new THREE.Mesh(model.wood, barkMaterial), new THREE.Mesh(model.canopy, canopyMaterial), new THREE.Mesh(model.leaves, leafMaterial));
          tree.scale.setScalar(0.85 + hash(k * 7.3) * 0.4);
          place(tree, s, side * (7.5 + hash(k * 2.9) * 9), -27, dir, hash(k) * 6);
        }
        for (let j = 0; j < 2; j++) {
          if (hash(k * 13.1 + j) > 0.25 + look.density * 0.35) continue;
          const model = crowns[Math.floor(hash(k * 3.3 + j) * crowns.length)]!;
          const crown = new THREE.Group();
          crown.add(new THREE.Mesh(model.canopy, canopyMaterial), new THREE.Mesh(model.leaves, leafMaterial));
          crown.scale.setScalar(1 + hash(k * 1.7 + j) * 1);
          place(crown, s + (j - 0.5) * 2, side * (11 + hash(k * 4.1 + j) * 28), -13 - hash(k * 6.1 + j) * 14, dir, hash(k + j) * 6);
        }
        if (!corner && hash(k * 9.7) < 0.12) {
          const column = new THREE.Mesh(columnGeometry, carvedMaterial);
          const rise = 0.8 + hash(k * 8.3) * 3.5;
          place(column, s, side * 3.2, rise, dir);
          const cap = new THREE.Mesh(capGeometry, carvedMaterial);
          cap.scale.set(3.4, 1, 3.4);
          place(cap, s, side * 3.2, rise + 0.06, dir);
          const flame = new THREE.Sprite(flameMaterial);
          flame.scale.set(0.9, 1.7, 1);
          place(flame, s, side * 3.2, rise + 0.95, dir);
          flames.push(flame);
        }
      }
    }
    for (const [id, coin] of layout.coins.entries()) {
      if (coin.s < index * CHUNK * TILE - TILE / 2 || coin.s >= (index + 1) * CHUNK * TILE - TILE / 2) continue;
      if (collected.has(id)) continue;
      const mesh = new THREE.Mesh(coinGeometry, coinMaterial);
      mesh.castShadow = true;
      place(mesh, coin.s, coin.lane * LANE, 1, segmentAt(layout, coin.s).dir);
      coins.push({ mesh, id, s: coin.s });
    }
    course.add(group);
    return { group, coins, flames };
  };

  const clearChunks = () => {
    for (const chunk of chunks.values()) course.remove(chunk.group);
    chunks.clear();
  };

  const follower = createMusicFollower();
  let lanes: MusicLane[] = [];
  let source = { key: "idle", song: follower.idle, time: 0 };
  let speedScale = 1,
    pendingScale = 1,
    scaleChangedAt = 0;
  // The course's placement in the world: a turn about the vertical and an offset.
  let placementYaw = 0;
  const placementOffset = new THREE.Vector3();
  const placement = new THREE.Matrix4();
  const updatePlacement = () => {
    placement.makeRotationY(placementYaw).setPosition(placementOffset);
    course.matrix.copy(placement);
    course.matrixWorldNeedsUpdate = true;
  };
  // Runner and camera state, in course space.
  const runnerAt = new THREE.Vector3();
  let runnerYaw = 0,
    lane = 0,
    stride = 0,
    cameraYaw = 0,
    placed = false;
  const cameraAt = new THREE.Vector3();

  const relayout = () => {
    const before = layoutKey ? { at: runnerAt.clone().applyMatrix4(placement), yaw: runnerYaw + placementYaw } : undefined;
    const cameraWorld = cameraAt.clone().applyMatrix4(placement);
    const cameraWorldYaw = cameraYaw + placementYaw;
    layout = buildLayout(source.song, speedScale);
    layoutKey = `${source.key}:${speedScale}`;
    collected.clear();
    clearChunks();
    if (!before) return updatePlacement();
    const s = distanceAt(layout, source.time);
    const local = new THREE.Vector3();
    const segment = poseAt(layout, s, local);
    placementYaw = before.yaw - yawOf(segment.dir);
    placementOffset.copy(before.at).sub(local.applyAxisAngle(new THREE.Vector3(0, 1, 0), placementYaw));
    updatePlacement();
    const inverse = placement.clone().invert();
    cameraAt.copy(cameraWorld).applyMatrix4(inverse);
    cameraYaw = cameraWorldYaw - placementYaw;
    runnerYaw = yawOf(segment.dir);
  };

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.25, 0.4, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const day = { zenith: new THREE.Color(0x3f86d8), horizon: new THREE.Color(0xc9dccb), sun: new THREE.Color(0xffd9a0), fog: new THREE.Color(0xb7c9b4), far: new THREE.Color(0x8fa9a3), near: new THREE.Color(0x6f8e80) };
  const dusk = { zenith: new THREE.Color(0x140b2a), horizon: new THREE.Color(0x8a3d4a), sun: new THREE.Color(0xff6a2a), fog: new THREE.Color(0x3d2440), far: new THREE.Color(0x3a2440), near: new THREE.Color(0x2a1a30) };

  let width = 0,
    height = 0,
    pixelRatio = 0,
    previous: number | undefined,
    status = "";
  const ahead = new THREE.Vector3(),
    focus = new THREE.Vector3(),
    worldRunner = new THREE.Vector3(),
    tmp = new THREE.Vector3();
  const yAxis = new THREE.Vector3(0, 1, 0);
  const angleTowards = (from: number, to: number, rate: number) => {
    const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
    return from + delta * rate;
  };

  return {
    setLook(next) {
      target = next;
    },
    setMusic(next) {
      lanes = next;
    },
    status() {
      return status;
    },
    draw(time) {
      const bounds = host.getBoundingClientRect();
      const w = Math.max(1, bounds.width),
        h = Math.max(1, bounds.height);
      const ratio = Math.min(devicePixelRatio, 1.5, Math.sqrt(1_600_000 / (w * h)));
      if (w !== width || h !== height || ratio !== pixelRatio) {
        width = w;
        height = h;
        pixelRatio = ratio;
        renderer.setPixelRatio(ratio);
        renderer.setSize(w, h, false);
        composer.setPixelRatio(ratio);
        composer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      const dt = previous === undefined ? 0 : Math.min(0.05, Math.max(0, time - previous));
      previous = time;
      const blend = 1 - Math.exp(-dt * 3);
      for (const key of ["intensity", "motion", "density", "halloween"] as const)
        look[key] += (target[key] - look[key]) * blend;

      const wanted = Math.round((0.6 + target.motion * 0.4) * 10) / 10;
      if (wanted !== pendingScale) {
        pendingScale = wanted;
        scaleChangedAt = time;
      }
      if (pendingScale !== speedScale && time - scaleChangedAt > 0.4) speedScale = pendingScale;
      source = follower.update(lanes, time, dt);
      if (`${source.key}:${speedScale}` !== layoutKey) relayout();

      // Where the runner is, and what is coming up.
      const s = distanceAt(layout, source.time);
      const speed = (distanceAt(layout, source.time + 0.1) - s) * 10;
      const segment = poseAt(layout, s, runnerAt);
      const right = DIRS[(segment.dir + 1) % 4]!;
      let jump = 0,
        slide = 0,
        laneTarget = 0;
      for (const [at, kind] of layout.obstacles) {
        const d = at - s;
        if (kind === "arch" && d > -2.5 && d < 5) slide = Math.max(slide, THREE.MathUtils.smoothstep(5 - Math.max(d, 0), 0, 1.6) * THREE.MathUtils.smoothstep(d, -2.5, -1));
        if (kind !== "arch" && Math.abs(d) < 3.6) jump = Math.max(jump, Math.sin(((d + 3.6) / 7.2) * Math.PI) * (kind === "gap" ? 1.5 : 1.1));
      }
      for (const coin of layout.coins) {
        if (coin.s > s - 1 && coin.s < s + 16) {
          laneTarget = coin.lane;
          break;
        }
      }
      lane += (laneTarget - lane) * (1 - Math.exp(-dt * 5));
      runnerAt.addScaledVector(right, lane * LANE);
      runnerYaw = angleTowards(runnerYaw, yawOf(segment.dir), 1 - Math.exp(-dt * 16));

      // The runner: stride with the ground covered, tuck for jumps, lean back to slide.
      stride += (speed * dt) / 2.6;
      const phase = stride * Math.PI * 2;
      const airborne = jump > 0.05;
      runner.root.position.copy(runnerAt);
      runner.root.position.y += jump;
      runner.root.rotation.y = runnerYaw;
      runner.body.rotation.x = slide * 1.15;
      runner.body.position.y = -slide * 0.55;
      runner.hips.position.y = 0.98 + (airborne ? 0 : Math.abs(Math.cos(phase)) * 0.07);
      runner.torso.rotation.x = -0.28 * (1 - slide);
      runner.legs.forEach((leg, i) => {
        const swing = Math.sin(phase + i * Math.PI);
        leg.pivot.rotation.x = airborne ? 0.9 - i * 0.5 : slide > 0.3 ? 1.4 : swing * 0.95;
        leg.joint.rotation.x = airborne ? -1.5 : slide > 0.3 ? -0.2 : -(0.25 + Math.max(0, -Math.cos(phase + i * Math.PI)) * 1.3);
      });
      runner.arms.forEach((arm, i) => {
        const swing = Math.sin(phase + i * Math.PI);
        arm.pivot.rotation.x = airborne ? -2.3 : -swing * 0.9;
        arm.pivot.rotation.z = (i ? -1 : 1) * (airborne ? 0.5 : 0.12);
        arm.joint.rotation.x = 1.25;
      });
      runner.head.rotation.x = 0.18 * (1 - slide);
      shadowBlob.position.copy(runnerAt);
      shadowBlob.position.y += 0.02;
      shadowBlob.scale.setScalar(1 - Math.min(0.6, jump * 0.35));
      shadowBlob.visible = layout.obstacles.get(Math.round(s / TILE) * TILE) !== "gap";

      // Demon monkeys: they hang back in calm passages and close in on drops.
      const style = sectionAt(source.song, source.time)?.style ?? "vocal";
      const chase = Math.max(look.halloween * 0.7, style === "drop" ? 1 : style === "build" ? 0.6 : 0.25);
      monkeys.forEach((monkey, i) => {
        const lag = monkey.lag + (1 - chase) * 7;
        const at = s - lag;
        const monkeySegment = poseAt(layout, at, monkey.root.position);
        monkey.root.position.addScaledVector(DIRS[(monkeySegment.dir + 1) % 4]!, monkey.offset + lane * LANE * 0.5);
        const gallop = phase * 0.9 + monkey.phase;
        monkey.root.position.y += Math.abs(Math.sin(gallop)) * 0.35;
        monkey.root.rotation.y = yawOf(monkeySegment.dir);
        monkey.body.rotation.x = Math.sin(gallop) * 0.25;
        monkey.limbs.forEach((limb) => (limb.pivot.rotation.x = Math.sin(gallop + (limb.front ? 0 : Math.PI)) * 0.9));
        monkey.root.visible = chase > 0.2 || i === 1;
      });

      // The chase camera swings round corners a moment behind the runner.
      cameraYaw = angleTowards(cameraYaw, runnerYaw, 1 - Math.exp(-dt * 4.5));
      ahead.set(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
      tmp.copy(runnerAt).addScaledVector(ahead, -6.4);
      tmp.y = runnerAt.y + 3.5 + jump * 0.3;
      if (!placed || cameraAt.distanceTo(tmp) > 30) {
        cameraAt.copy(tmp);
        placed = true;
      } else cameraAt.lerp(tmp, 1 - Math.exp(-dt * 7));
      focus.copy(runnerAt).addScaledVector(ahead, 7).setY(runnerAt.y + 1.1 + jump * 0.4);
      camera.position.copy(cameraAt).applyMatrix4(placement);
      camera.up.copy(yAxis);
      camera.lookAt(focus.applyMatrix4(placement));
      backdrop.position.set(camera.position.x, camera.position.y, camera.position.z);
      backdrop.rotation.y = 0;

      // Keep the world built ahead and cleared behind.
      const first = Math.floor((s - BEHIND) / (CHUNK * TILE));
      const last = Math.floor((s + AHEAD) / (CHUNK * TILE));
      for (const [index, chunk] of chunks)
        if (index < first || index > last) {
          course.remove(chunk.group);
          chunks.delete(index);
        }
      for (let index = Math.max(0, first); index <= last; index++) if (!chunks.has(index)) chunks.set(index, buildChunk(index));

      // Coins spin, and fly up in a sparkle as the runner sweeps them up.
      const spook = THREE.MathUtils.smoothstep(look.halloween, 0.1, 0.8);
      for (const chunk of chunks.values()) {
        for (const coin of chunk.coins) {
          coin.mesh.rotation.y = time * 4 + coin.s;
          if (!collected.has(coin.id) && coin.s < s + 0.6) {
            collected.add(coin.id);
            const sparkle = new THREE.Sprite(sparkleMaterial.clone());
            sparkle.position.copy(coin.mesh.position);
            chunk.group.add(sparkle);
            sparkles.push({ sprite: sparkle, age: 0 });
          }
          if (collected.has(coin.id)) {
            coin.mesh.position.y += dt * 6;
            coin.mesh.scale.multiplyScalar(Math.exp(-dt * 9));
          }
        }
        for (const flame of chunk.flames) {
          flame.visible = spook > 0.05;
          const flicker = 0.85 + Math.sin(time * 17 + flame.position.x) * 0.1 + Math.sin(time * 29 + flame.position.z) * 0.08;
          flame.scale.set(0.9 * flicker * spook, 1.7 * flicker * spook, 1);
        }
      }
      for (let i = sparkles.length - 1; i >= 0; i--) {
        const sparkle = sparkles[i]!;
        sparkle.age += dt;
        const t = sparkle.age / 0.4;
        sparkle.sprite.scale.setScalar(0.4 + t * 1.6);
        (sparkle.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - t);
        if (t >= 1) {
          sparkle.sprite.removeFromParent();
          (sparkle.sprite.material as THREE.SpriteMaterial).dispose();
          sparkles.splice(i, 1);
        }
      }

      // Daylight, or dusk with torches when it is spooky.
      skyUniforms.zenith.value.lerpColors(day.zenith, dusk.zenith, spook);
      skyUniforms.horizon.value.lerpColors(day.horizon, dusk.horizon, spook);
      skyUniforms.sunColor.value.lerpColors(day.sun, dusk.sun, spook);
      skyUniforms.moon.value = spook;
      fog.color.lerpColors(day.fog, dusk.fog, spook);
      farMaterial.color.lerpColors(day.far, dusk.far, spook);
      nearMaterial.color.lerpColors(day.near, dusk.near, spook);
      (abyss.material as THREE.MeshBasicMaterial).color.copy(fog.color).multiplyScalar(0.55);
      hemisphere.intensity = (1.5 - spook * 0.9) * (0.8 + look.intensity * 0.2);
      sun.color.lerpColors(day.sun, dusk.sun, spook);
      sun.intensity = (3.2 - spook * 2.2) * (0.8 + look.intensity * 0.2);
      worldRunner.copy(runnerAt).applyMatrix4(placement);
      sun.target.position.copy(worldRunner);
      sun.position.copy(worldRunner).addScaledVector(sunDirection, 30);
      bloom.strength = 0.15 + look.intensity * 0.15 + spook * 0.25;

      const next = source.song.sections.find((section) => section.start > source.time);
      const upcoming = [...layout.obstacles].filter(([at]) => at > s && at - s < speed * 3).map(([, kind]) => kind);
      status =
        (source.key === "idle" ? "Demo run (no song playing)" : "Following the loudest deck") +
        ` · ${style.toUpperCase()}` +
        (next ? ` · ${next.style} in ${Math.ceil(next.start - source.time)}s` : "") +
        (upcoming.length ? ` · ${upcoming[0]} ahead` : "");

      composer.render(dt);
    },
    dispose() {
      clearChunks();
      composer.dispose();
      for (const item of disposables) item.dispose();
      for (const sparkle of sparkles) (sparkle.sprite.material as THREE.SpriteMaterial).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
