import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { DEFAULT_VISUAL_LOOK, type VisualLook } from "../../../dj-monitor/src/visual-presets.js";
import {
  buildChart,
  idleWaveform,
  NOTE_LANES,
  type Chart,
  type Note,
} from "../music/note-chart.js";
import { sectionAt, type Style } from "../music/song-map.js";
import type { MusicLane, SceneEngine } from "../scenes.js";

// Lime, orchid, banana, lagoon and toucan orange, left to right.
const LANE_COLORS = [0x7dff3a, 0xff3ab4, 0xffd23a, 0x2ad8ff, 0xff7a1a];
const LANE_WIDTH = 1.1;
const HIGHWAY_WIDTH = LANE_WIDTH * NOTE_LANES;
const RAIL = 0.18;
// The highway runs from just in front of the strike line far into the mist.
const NEAR = 2.5;
const LENGTH = 44;
/** World units a note travels per second at motion 1. */
const SPEED = 9;
const MAX_NOTES = 480;
const MAX_FRETS = 96;
const PARTICLES = 900;
const FIREFLIES = 150;
const EYE_PAIRS = 9;
const STREAKS = [50, 100, 250, 500, 1000];
const WAVES = 48;
/** How long a struck gem is drawn squashing into its fret button. */
const ABSORB = 0.08;
const BUTTON_Y = 0.1;
const MULTIPLIER_COLORS = ["#7dff3a", "#ffd23a", "#2ad8ff", "#ff3ab4"];

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const laneX = (lane: number) => (lane - (NOTE_LANES - 1) / 2) * LANE_WIDTH;

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------
// The jungle backdrop is painted once into layered canvases: sky, distant canopy, the
// jungle around the highway, and leaves framing the screen. Each layer sways a little.

type Paint = CanvasRenderingContext2D;
const W = 2048,
  H = 1024;

function canvas(draw: (c: Paint, random: () => number) => void, seed: number) {
  const element = document.createElement("canvas");
  element.width = W;
  element.height = H;
  draw(element.getContext("2d")!, seeded(seed));
  const texture = new THREE.CanvasTexture(element);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Light the top of everything already painted, like moonlight on the leaves. */
function rimLight(c: Paint, color: string, from = 0, to = H) {
  c.save();
  c.globalCompositeOperation = "source-atop";
  const g = c.createLinearGradient(0, from, 0, to);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  c.restore();
}

function frond(
  c: Paint,
  x: number,
  y: number,
  angle: number,
  length: number,
  droop: number,
  width: number,
) {
  const ex = x + Math.cos(angle) * length,
    ey = y + Math.sin(angle) * length + length * droop;
  const cx = x + Math.cos(angle) * length * 0.6,
    cy = y + Math.sin(angle) * length * 0.6 - length * 0.12;
  c.lineWidth = width;
  c.beginPath();
  c.moveTo(x, y);
  c.quadraticCurveTo(cx, cy, ex, ey);
  c.stroke();
  for (let t = 0.08; t < 1; t += 0.055) {
    const px = (1 - t) * (1 - t) * x + 2 * (1 - t) * t * cx + t * t * ex;
    const py = (1 - t) * (1 - t) * y + 2 * (1 - t) * t * cy + t * t * ey;
    const tx = 2 * (1 - t) * (cx - x) + 2 * t * (ex - cx),
      ty = 2 * (1 - t) * (cy - y) + 2 * t * (ey - cy);
    const norm = Math.hypot(tx, ty) || 1;
    const leaf = length * 0.24 * (1 - t * 0.65);
    c.lineWidth = Math.max(1.5, width * 0.7 * (1 - t));
    for (const side of [-1, 1]) {
      c.beginPath();
      c.moveTo(px, py);
      c.quadraticCurveTo(
        px + (-ty / norm) * side * leaf * 0.6 + (tx / norm) * leaf * 0.3,
        py + (tx / norm) * side * leaf * 0.6 + (ty / norm) * leaf * 0.3,
        px + (-ty / norm) * side * leaf * 0.8 + (tx / norm) * leaf * 0.7,
        py + (tx / norm) * side * leaf * 0.8 + (ty / norm) * leaf * 0.7 + leaf * 0.35,
      );
      c.stroke();
    }
  }
}

function palm(
  c: Paint,
  random: () => number,
  x: number,
  base: number,
  height: number,
  lean: number,
) {
  const topX = x + lean,
    topY = base - height;
  c.lineCap = "round";
  const segments = 24;
  for (let i = 0; i < segments; i++) {
    const at = (t: number) => {
      const mx = x + lean * 0.15,
        my = base - height * 0.5;
      return [
        (1 - t) * (1 - t) * x + 2 * (1 - t) * t * mx + t * t * topX,
        (1 - t) * (1 - t) * base + 2 * (1 - t) * t * my + t * t * topY,
      ] as const;
    };
    const [x0, y0] = at(i / segments),
      [x1, y1] = at((i + 1) / segments);
    c.lineWidth = height * (0.055 - 0.03 * (i / segments));
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
  }
  const count = 8 + Math.floor(random() * 3);
  for (let k = 0; k < count; k++) {
    const angle = -Math.PI / 2 + (k / (count - 1) - 0.5) * Math.PI * 1.6 + (random() - 0.5) * 0.25;
    frond(
      c,
      topX,
      topY,
      angle,
      height * (0.36 + random() * 0.16),
      0.35 + random() * 0.25,
      height * 0.012 + 2,
    );
  }
}

function fern(c: Paint, random: () => number, x: number, base: number, size: number) {
  c.lineCap = "round";
  for (let k = 0; k < 9; k++) {
    const angle = -Math.PI / 2 + (k / 8 - 0.5) * Math.PI * 1.1 + (random() - 0.5) * 0.2;
    frond(c, x + (random() - 0.5) * size * 0.2, base, angle, size * (0.6 + random() * 0.5), 0.5, 3);
  }
}

const leafSprites = new Map<string, HTMLCanvasElement>();
/** A split monstera leaf pointing right, cached per colour. */
function leafSprite(color: string) {
  const cached = leafSprites.get(color);
  if (cached) return cached;
  const element = document.createElement("canvas");
  element.width = 512;
  element.height = 400;
  const c = element.getContext("2d")!;
  const s = 480;
  c.translate(16, 200);
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(0, 0);
  c.bezierCurveTo(s * 0.2, -s * 0.5, s * 0.85, -s * 0.42, s, 0);
  c.bezierCurveTo(s * 0.85, s * 0.42, s * 0.2, s * 0.5, 0, 0);
  c.fill();
  c.globalCompositeOperation = "destination-out";
  c.lineCap = "round";
  for (let i = 1; i <= 7; i++) {
    const t = i / 8;
    const half = s * 0.4 * Math.sin(Math.PI * t) + 6;
    c.lineWidth = s * 0.028;
    for (const side of [-1, 1]) {
      c.beginPath();
      c.moveTo(s * t + s * 0.05, side * (half + 10));
      c.lineTo(s * t - s * 0.02, side * s * 0.07);
      c.stroke();
    }
    if (i % 2 === 0) {
      c.beginPath();
      c.ellipse(
        s * t - s * 0.03,
        (i % 4 === 0 ? 1 : -1) * s * 0.14,
        s * 0.025,
        s * 0.012,
        0,
        0,
        Math.PI * 2,
      );
      c.fill();
    }
  }
  c.globalCompositeOperation = "source-over";
  c.strokeStyle = color;
  c.lineWidth = 10;
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(-s * 0.4, s * 0.12);
  c.stroke();
  leafSprites.set(color, element);
  return element;
}

function leaf(
  c: Paint,
  color: string,
  x: number,
  y: number,
  size: number,
  angle: number,
  flip = false,
) {
  c.save();
  c.translate(x, y);
  c.rotate(angle);
  if (flip) c.scale(1, -1);
  const sprite = leafSprite(color);
  const scale = size / 480;
  c.drawImage(sprite, -16 * scale, -200 * scale, sprite.width * scale, sprite.height * scale);
  c.restore();
}

function vine(c: Paint, random: () => number, x: number, length: number, color: string) {
  const sway = (random() - 0.5) * 120;
  c.strokeStyle = color;
  c.fillStyle = color;
  c.lineWidth = 3 + random() * 3;
  c.beginPath();
  c.moveTo(x, -10);
  c.bezierCurveTo(x + sway, length * 0.4, x - sway * 0.5, length * 0.7, x + sway * 0.3, length);
  c.stroke();
  for (let t = 0.05; t < 1; t += 0.045 + random() * 0.03) {
    const u = 1 - t;
    const px =
      u * u * u * x +
      3 * u * u * t * (x + sway) +
      3 * u * t * t * (x - sway * 0.5) +
      t * t * t * (x + sway * 0.3);
    const py =
      3 * u * u * t * length * 0.4 +
      3 * u * t * t * length * 0.7 +
      t * t * t * length -
      10 * u * u * u;
    const side = Math.round(t * 40) % 2 ? 1 : -1;
    c.beginPath();
    c.ellipse(px + side * 9, py, 11 + random() * 6, 5, side * 0.6, 0, Math.PI * 2);
    c.fill();
  }
}

function toucan(c: Paint, x: number, y: number, size: number) {
  c.save();
  c.translate(x, y);
  c.fillStyle = "#04100c";
  // Branch, body and tail.
  c.fillRect(-size * 1.6, size * 0.55, size * 3.2, size * 0.12);
  c.beginPath();
  c.ellipse(0, 0, size * 0.42, size * 0.6, -0.25, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.moveTo(-size * 0.2, size * 0.4);
  c.lineTo(-size * 0.45, size * 1.15);
  c.lineTo(-size * 0.05, size * 0.5);
  c.fill();
  c.beginPath();
  c.arc(size * 0.12, -size * 0.55, size * 0.27, 0, Math.PI * 2);
  c.fill();
  // The beak catches the moonlight.
  const beak = c.createLinearGradient(size * 0.3, -size * 0.7, size * 1.3, -size * 0.4);
  beak.addColorStop(0, "#ffb84a");
  beak.addColorStop(0.6, "#ff6a1a");
  beak.addColorStop(1, "#5a1a08");
  c.fillStyle = beak;
  c.beginPath();
  c.moveTo(size * 0.32, -size * 0.72);
  c.quadraticCurveTo(size * 1.1, -size * 0.85, size * 1.35, -size * 0.42);
  c.quadraticCurveTo(size * 0.9, -size * 0.45, size * 0.32, -size * 0.42);
  c.fill();
  c.fillStyle = "#f6ffcc";
  c.beginPath();
  c.arc(size * 0.2, -size * 0.6, size * 0.05, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

const paintSky = (c: Paint, random: () => number) => {
  const sky = c.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#03041a");
  sky.addColorStop(0.45, "#0a2238");
  sky.addColorStop(0.75, "#15433d");
  sky.addColorStop(1, "#0b2a22");
  c.fillStyle = sky;
  c.fillRect(0, 0, W, H);
  for (let i = 0; i < 420; i++) {
    const y = Math.pow(random(), 1.6) * H * 0.6;
    c.fillStyle = `rgba(220,255,240,${0.2 + random() * 0.7})`;
    c.fillRect(random() * W, y, random() < 0.1 ? 3 : 1.6, random() < 0.1 ? 3 : 1.6);
  }
  const mx = W * 0.74,
    my = H * 0.2;
  const halo = c.createRadialGradient(mx, my, 40, mx, my, 520);
  halo.addColorStop(0, "rgba(210,255,225,0.35)");
  halo.addColorStop(1, "rgba(210,255,225,0)");
  c.fillStyle = halo;
  c.fillRect(0, 0, W, H);
  c.fillStyle = "#f3f0cf";
  c.beginPath();
  c.arc(mx, my, 74, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "rgba(170,170,140,0.35)";
  for (const [dx, dy, r] of [
    [-22, -14, 16],
    [18, 20, 11],
    [26, -26, 8],
    [-8, 30, 7],
  ] as const) {
    c.beginPath();
    c.arc(mx + dx, my + dy, r, 0, Math.PI * 2);
    c.fill();
  }
  // Two ranges of misty mountains.
  for (const [base, height, color] of [
    [0.62, 0.22, "#123543"],
    [0.7, 0.16, "#0e2b31"],
  ] as const) {
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(0, H);
    let y = H * base;
    for (let x = 0; x <= W; x += 16) {
      y += (random() - 0.5) * 28;
      y = Math.max(H * (base - height), Math.min(H * base, y));
      c.lineTo(x, y + Math.sin(x * 0.004 + base * 9) * H * height * 0.5);
    }
    c.lineTo(W, H);
    c.fill();
  }
  const mist = c.createLinearGradient(0, H * 0.6, 0, H * 0.85);
  mist.addColorStop(0, "rgba(120,210,170,0)");
  mist.addColorStop(0.5, "rgba(120,210,170,0.18)");
  mist.addColorStop(1, "rgba(120,210,170,0)");
  c.fillStyle = mist;
  c.fillRect(0, 0, W, H);
};

const paintFar = (c: Paint, random: () => number) => {
  const color = "#0a221c";
  c.fillStyle = color;
  c.strokeStyle = color;
  for (let x = -40; x < W + 40; x += 34) {
    const y = H * 0.62 + Math.sin(x * 0.006) * 40 + (random() - 0.5) * 40;
    c.beginPath();
    c.arc(x, y, 40 + random() * 55, 0, Math.PI * 2);
    c.fill();
  }
  c.fillRect(0, H * 0.66, W, H);
  for (let i = 0; i < 9; i++) {
    const x = (i / 8) * W + (random() - 0.5) * 140;
    palm(c, random, x, H * 0.66, 220 + random() * 170, (random() - 0.5) * 120);
  }
  rimLight(c, "rgba(90,180,150,0.45)", H * 0.35, H * 0.75);
};

const paintMid = (c: Paint, random: () => number) => {
  const color = "#06160f";
  c.fillStyle = color;
  c.strokeStyle = color;
  // Dense jungle walls on both sides; the middle stays open for the highway.
  for (const side of [0, 1]) {
    const edge = side ? W : 0,
      dir = side ? -1 : 1;
    for (let i = 0; i < 26; i++) {
      const x = edge + dir * Math.pow(random(), 2) * W * 0.22;
      c.beginPath();
      c.arc(x, H * (0.3 + random() * 0.7), 50 + random() * 70, 0, Math.PI * 2);
      c.fill();
    }
    // Leaves break up the wall's outline so it reads as foliage, not shapes.
    for (let i = 0; i < 90; i++) {
      const x = edge + dir * Math.pow(random(), 1.3) * W * 0.36;
      const y = H * (0.22 + random() * 0.8);
      const angle = (side ? Math.PI : 0) + (random() - 0.5) * 2.4;
      leaf(c, color, x, y, 120 + random() * 160, angle, random() > 0.5);
    }
    for (let i = 0; i < 5; i++) {
      const x = edge + dir * (40 + random() * W * 0.3);
      c.lineWidth = 26 + random() * 30;
      c.beginPath();
      c.moveTo(x, H);
      c.bezierCurveTo(x + dir * 30, H * 0.6, x - dir * 40, H * 0.3, x + dir * 20, 0);
      c.stroke();
    }
    for (let i = 0; i < 3; i++)
      palm(
        c,
        random,
        edge + dir * (W * 0.12 + random() * W * 0.22),
        H * 0.95,
        380 + random() * 200,
        -dir * (60 + random() * 120),
      );
    for (let i = 0; i < 6; i++)
      fern(c, random, edge + dir * random() * W * 0.36, H, 150 + random() * 90);
  }
  // A canopy across the top with vines hanging into the clearing.
  for (let x = -60; x < W + 60; x += 60) {
    c.beginPath();
    c.arc(x, -60 + random() * 50, 60 + random() * 50, 0, Math.PI * 2);
    c.fill();
  }
  for (let i = 0; i < 70; i++)
    leaf(
      c,
      color,
      random() * W,
      random() * H * 0.12,
      110 + random() * 120,
      Math.PI / 2 + (random() - 0.5) * 2.2,
      random() > 0.5,
    );
  for (let i = 0; i < 26; i++) vine(c, random, random() * W, H * (0.15 + random() * 0.4), color);
  rimLight(c, "rgba(40,120,90,0.35)", 0, H * 0.5);
  toucan(c, W * 0.2, H * 0.4, 44);
};

const paintNear = (c: Paint, random: () => number) => {
  const color = "#020a06";
  // Big leaves in the corners frame the screen without covering the highway.
  for (let i = 0; i < 7; i++) {
    leaf(
      c,
      color,
      -60 + random() * 120,
      H * (0.55 + random() * 0.5),
      420 + random() * 240,
      -0.6 - random() * 0.7,
      random() > 0.5,
    );
    leaf(
      c,
      color,
      W + 60 - random() * 120,
      H * (0.55 + random() * 0.5),
      420 + random() * 240,
      Math.PI + 0.6 + random() * 0.7,
      random() > 0.5,
    );
  }
  for (let i = 0; i < 4; i++) {
    leaf(
      c,
      color,
      -40 + random() * 160,
      -40 + random() * 140,
      380 + random() * 200,
      0.3 + random() * 0.6,
      random() > 0.5,
    );
    leaf(
      c,
      color,
      W + 40 - random() * 160,
      -40 + random() * 140,
      380 + random() * 200,
      Math.PI - 0.3 - random() * 0.6,
      random() > 0.5,
    );
  }
  c.strokeStyle = color;
  c.fillStyle = color;
  for (let i = 0; i < 3; i++) fern(c, random, random() * W * 0.12, H + 20, 260);
  for (let i = 0; i < 3; i++) fern(c, random, W - random() * W * 0.12, H + 20, 260);
  for (let i = 0; i < 5; i++)
    vine(
      c,
      random,
      random() < 0.5 ? random() * W * 0.18 : W - random() * W * 0.18,
      H * (0.2 + random() * 0.25),
      color,
    );
  // The glowing highway lights the leaves from below.
  c.save();
  c.globalCompositeOperation = "source-atop";
  const glow = c.createRadialGradient(W / 2, H * 1.1, 100, W / 2, H * 1.1, W * 0.55);
  glow.addColorStop(0, "rgba(140,255,150,0.35)");
  glow.addColorStop(1, "rgba(140,255,150,0)");
  c.fillStyle = glow;
  c.fillRect(0, 0, W, H);
  c.restore();
};

function sprite() {
  const element = document.createElement("canvas");
  element.width = element.height = 64;
  const c = element.getContext("2d")!;
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.7)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(element);
}

const LAYER_VERTEX = /* glsl */ `varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;

const CELL_GLSL = /* glsl */ `
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float cell(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  float d = 1.;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(x, y);
      d = min(d, length(g + hash2(i + g) * .8 + .1 - f));
    }
  return d;
}`;

// ---------------------------------------------------------------------------------------

type Source = { key: string; chart: Chart; time: number; label: string };

/**
 * A rhythm-game highway through a night jungle. The playing track's whole note chart is
 * known ahead of time from its Rekordbox beat grid and waveform, so every gem rolls down
 * its lane and lands on the strike line exactly as the beat it stands for plays.
 */
export async function createJungleHero(host: HTMLCanvasElement): Promise<SceneEngine> {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.setClearColor(0x000000, 1);
  host.after(renderer.domElement);

  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(item: T) => (disposables.push(item), item);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 400);
  const base = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 400);
  // Three passes: the jungle behind, the highway, then leaves in front of everything.
  const back = new THREE.Scene();
  const scene = new THREE.Scene();
  const front = new THREE.Scene();
  const mist = new THREE.Color(0x06201a);
  scene.fog = new THREE.Fog(mist, 26, 50);

  scene.add(new THREE.HemisphereLight(0xb8ffd8, 0x1a0c02, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2d0, 1.6);
  sun.position.set(2, 8, 5);
  scene.add(sun);

  // --- Backdrop layers ---
  type Layer = {
    mesh: THREE.Mesh;
    material: THREE.ShaderMaterial;
    distance: number;
    margin: number;
  };
  const layers: Layer[] = [];
  const layerGeometry = keep(new THREE.PlaneGeometry(2, 1));
  const addLayer = (
    target: THREE.Scene,
    texture: THREE.Texture,
    distance: number,
    order: number,
    margin = 1.2,
  ) => {
    keep(texture);
    const material = keep(
      new THREE.ShaderMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          map: { value: texture },
          time: { value: 0 },
          sway: { value: 1 },
          light: { value: 1 },
          glow: { value: 0 },
          glowColor: { value: new THREE.Color(0x3dff9a) },
        },
        vertexShader: LAYER_VERTEX,
        fragmentShader: /* glsl */ `uniform sampler2D map; uniform float time, sway, light, glow; uniform vec3 glowColor;
          varying vec2 vUv;
          void main() {
            vec2 uv = vUv;
            float reach = 1. - uv.y * .4;
            uv.x += (sin(uv.y * 9. + time * .9) * .0025 + sin(uv.y * 23. + time * 1.7) * .001) * sway * reach;
            uv.y += sin(uv.x * 7. + time * .7) * .0018 * sway;
            vec4 t = texture2D(map, uv);
            vec3 color = t.rgb * light + glowColor * glow * pow(1. - vUv.y, 2.5) * t.a;
            gl_FragColor = vec4(color, t.a);
          }`,
      }),
    );
    const mesh = new THREE.Mesh(layerGeometry, material);
    mesh.renderOrder = order;
    target.add(mesh);
    const layer = { mesh, material, distance, margin };
    layers.push(layer);
    return layer;
  };
  const sky = addLayer(back, canvas(paintSky, 11), 120, 0, 1.25);
  const far = addLayer(back, canvas(paintFar, 23), 95, 2);
  const mid = addLayer(back, canvas(paintMid, 37), 60, 4, 1.18);
  const near = addLayer(front, canvas(paintNear, 53), 9, 0, 1.08);

  // A jaguar watches from the sky; its eyes open on drops.
  const jaguarMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      premultipliedAlpha: true,
      uniforms: { open: { value: 0 }, glow: { value: 0 }, look: { value: 0 } },
      vertexShader: LAYER_VERTEX,
      fragmentShader: /* glsl */ `uniform float open, glow, look; varying vec2 vUv;
        void main() {
          vec2 uv = (vUv * 2. - 1.) * vec2(2., 1.);
          vec3 color = vec3(0.);
          float alpha = 0.;
          for (int k = 0; k < 2; k++) {
            float side = k == 0 ? -1. : 1.;
            vec2 p = (uv - vec2(side * .95, 0.)) / .7;
            float tilt = side * -.22;
            p = mat2(cos(tilt), -sin(tilt), sin(tilt), cos(tilt)) * p;
            float h = .5 * open * (1. - p.x * p.x);
            float lid = abs(p.y) - h;
            float eye = smoothstep(.03, -.03, lid) * step(abs(p.x), 1.) * smoothstep(.04, .15, open);
            vec2 q = p - vec2(look * .25, 0.);
            float r = length(q * vec2(1., 1.5));
            vec3 iris = mix(vec3(1.4, 1.05, .15), vec3(.4, 1.2, .1), smoothstep(.05, .9, r)) * (.75 + glow * .4);
            float pupil = smoothstep(.1 + glow * .05, .06, abs(q.x) / (1. - .5 * abs(q.y)));
            color += iris * eye * (1. - pupil);
            alpha = max(alpha, eye);
            float halo = exp(-max(0., lid) * 7.) * exp(-max(0., abs(p.x) - 1.) * 5.) * open * (1. - eye);
            color += vec3(.5, 1., .25) * halo * .16 * (1. + glow);
            alpha = max(alpha, halo * .2);
          }
          gl_FragColor = vec4(color, alpha);
        }`,
    }),
  );
  const jaguar = new THREE.Mesh(layerGeometry, jaguarMaterial);
  jaguar.renderOrder = 1;
  back.add(jaguar);

  const dot = keep(sprite());
  const pointsMaterial = (size: number, attenuate = true) =>
    keep(
      new THREE.PointsMaterial({
        size,
        map: dot,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: attenuate,
      }),
    );

  // Animal eyes peering out of the jungle walls.
  const eyeGeometry = keep(new THREE.BufferGeometry());
  const eyePositions = new Float32Array(EYE_PAIRS * 2 * 3);
  const eyeColors = new Float32Array(EYE_PAIRS * 2 * 3);
  eyeGeometry.setAttribute("position", new THREE.BufferAttribute(eyePositions, 3));
  eyeGeometry.setAttribute("color", new THREE.BufferAttribute(eyeColors, 3));
  const eyesMaterial = pointsMaterial(1.1);
  eyesMaterial.depthTest = false;
  const eyes = new THREE.Points(eyeGeometry, eyesMaterial);
  eyes.renderOrder = 5;
  eyes.frustumCulled = false;
  back.add(eyes);
  const random = seeded(71);
  const eyeSpots = Array.from({ length: EYE_PAIRS }, (_, i) => ({
    u: i % 2 ? 0.04 + random() * 0.24 : 0.72 + random() * 0.24,
    v: 0.32 + random() * 0.4,
    color: new THREE.Color(random() > 0.4 ? 0xd8ff4a : 0xffb030),
    next: random() * 6,
    open: 0,
    awake: random() * 0.6 + 0.2,
  }));

  // --- Highway ---
  const laneColors = LANE_COLORS.map((hex) => new THREE.Color(hex));
  const hits = new Float32Array(NOTE_LANES);
  const highwayMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        scroll: { value: 0 },
        time: { value: 0 },
        fever: { value: 0 },
        pulse: { value: 0 },
        hits: { value: hits },
        colors: { value: laneColors },
      },
      vertexShader: LAYER_VERTEX,
      fragmentShader: /* glsl */ `uniform float scroll, time, fever, pulse; uniform float hits[${NOTE_LANES}];
        uniform vec3 colors[${NOTE_LANES}]; varying vec2 vUv;
        ${CELL_GLSL}
        void main() {
          float x = (vUv.x - .5) * ${(HIGHWAY_WIDTH + RAIL * 2).toFixed(3)};
          float d = vUv.y * ${LENGTH.toFixed(1)};
          float q = d - ${NEAR.toFixed(1)} + scroll;
          // Leopard rosettes on dark wood, scrolling with the song.
          float c = cell(vec2(x, q) * 1.15);
          float ring = smoothstep(.2, .27, c) * (1. - smoothstep(.36, .46, c));
          vec3 color = vec3(.07, .045, .02) + vec3(.06, .04, .012) * (1. - c);
          color *= 1. - ring * .75;
          float lanef = x / ${LANE_WIDTH.toFixed(3)} + ${(NOTE_LANES / 2).toFixed(1)};
          int lane = int(clamp(floor(lanef), 0., ${(NOTE_LANES - 1).toFixed(1)}));
          float lx = fract(lanef);
          float near = 1. - vUv.y;
          float hit = hits[lane];
          color += colors[lane] * (.05 + hit * .35 * pow(near, 3.)) * (1. - abs(lx - .5) * 1.3);
          float divider = smoothstep(.035, 0., min(lx, 1. - lx)) * step(abs(x), ${(HIGHWAY_WIDTH / 2).toFixed(3)});
          color += vec3(.45, 1., .55) * divider * (.25 + pulse * .25);
          // Gold rails that turn electric during a drop.
          float rail = smoothstep(${(RAIL * 0.9).toFixed(3)}, ${(RAIL * 0.3).toFixed(3)}, ${(HIGHWAY_WIDTH / 2 + RAIL).toFixed(3)} - abs(x));
          vec3 railColor = mix(vec3(1., .72, .25), vec3(.45, .8, .45) + .35 * sin(vec3(0., 2., 4.) + q * .4 - time * 5.), fever);
          color = mix(color, railColor * (.75 + pulse * .45), rail);
          color += vec3(.1, .6, .25) * fever * .08 * (.5 + .5 * sin(q * .9 - time * 7.));
          float fade = 1. - smoothstep(.68, 1., vUv.y);
          gl_FragColor = vec4(color, fade);
        }`,
    }),
  );
  const highwayGeometry = keep(new THREE.PlaneGeometry(HIGHWAY_WIDTH + RAIL * 2, LENGTH));
  highwayGeometry.rotateX(-Math.PI / 2);
  const highway = new THREE.Mesh(highwayGeometry, highwayMaterial);
  highway.position.z = NEAR - LENGTH / 2;
  highway.renderOrder = -1;
  scene.add(highway);

  const strike = new THREE.Mesh(
    keep(new THREE.BoxGeometry(HIGHWAY_WIDTH + RAIL * 2, 0.04, 0.08)),
    keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.95, 0.8) })),
  );
  strike.position.set(0, 0.02, 0);
  scene.add(strike);

  // Drum-pad targets on the strike line, with a light column for every hit.
  const ringGeometry = keep(new THREE.TorusGeometry(0.42, 0.065, 12, 48));
  ringGeometry.rotateX(-Math.PI / 2);
  const padGeometry = keep(new THREE.CircleGeometry(0.36, 40));
  padGeometry.rotateX(-Math.PI / 2);
  const buttonGeometry = keep(new THREE.CylinderGeometry(0.3, 0.34, 0.12, 32));
  const beamGeometry = keep(new THREE.PlaneGeometry(0.95, 5));
  beamGeometry.translate(0, 2.5, 0);
  const targets = laneColors.map((color, lane) => {
    const ring = new THREE.Mesh(
      ringGeometry,
      keep(new THREE.MeshBasicMaterial({ color: color.clone() })),
    );
    const pad = new THREE.Mesh(
      padGeometry,
      keep(new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.15) })),
    );
    const beamMaterial = keep(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { color: { value: color.clone() }, strength: { value: 0 } },
        vertexShader: LAYER_VERTEX,
        fragmentShader: /* glsl */ `uniform vec3 color; uniform float strength; varying vec2 vUv;
          void main() {
            float across = 1. - pow(abs(vUv.x - .5) * 2., 1.5);
            gl_FragColor = vec4(color * strength * across * pow(1. - vUv.y, 2.) * .9, 1.);
          }`,
      }),
    );
    const beam = new THREE.Mesh(beamGeometry, beamMaterial);
    for (const mesh of [ring, pad, beam]) {
      mesh.position.set(laneX(lane), 0.03, 0);
      scene.add(mesh);
    }
    pad.position.y = 0.015;
    // The fret button the player strikes: it sinks and lights up on every hit.
    const button = new THREE.Mesh(
      buttonGeometry,
      keep(
        new THREE.MeshStandardMaterial({
          color: color.clone().multiplyScalar(0.45),
          emissive: color.clone(),
          emissiveIntensity: 0.15,
          roughness: 0.35,
        }),
      ),
    );
    button.position.set(laneX(lane), BUTTON_Y, 0);
    scene.add(button);
    return { ring, pad, beam, beamMaterial, color, button };
  });

  // Shockwave rings that burst out of a button when it is struck.
  const waves = new THREE.InstancedMesh(
    keep(new THREE.TorusGeometry(0.45, 0.04, 6, 40).rotateX(-Math.PI / 2)),
    keep(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
    WAVES,
  );
  waves.frustumCulled = false;
  waves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  waves.setColorAt(0, new THREE.Color());
  waves.count = 0;
  scene.add(waves);
  const waveLane = new Int8Array(WAVES);
  const waveAge = new Float32Array(WAVES).fill(Infinity);
  const waveBig = new Uint8Array(WAVES);
  let nextWave = 0;

  // --- Notes ---
  const instanced = (geometry: THREE.BufferGeometry, material: THREE.Material, count: number) => {
    const mesh = new THREE.InstancedMesh(keep(geometry), keep(material), count);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color());
    mesh.count = 0;
    scene.add(mesh);
    return mesh;
  };
  const gemBase = instanced(
    new THREE.CylinderGeometry(0.47, 0.47, 0.08, 36),
    new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 }),
    MAX_NOTES,
  );
  const gemBody = instanced(
    new THREE.CylinderGeometry(0.38, 0.42, 0.17, 36),
    new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.15 }),
    MAX_NOTES,
  );
  const gemCap = instanced(
    new THREE.CylinderGeometry(0.17, 0.2, 0.2, 28),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    MAX_NOTES,
  );
  const bigRing = instanced(
    (() => {
      const geometry = new THREE.TorusGeometry(0.56, 0.05, 8, 40);
      geometry.rotateX(-Math.PI / 2);
      return geometry;
    })(),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    MAX_NOTES,
  );
  const tails = instanced(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    MAX_NOTES,
  );
  const frets = instanced(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
    MAX_FRETS,
  );

  // --- Particles: hit sparks and fireflies ---
  const sparkGeometry = keep(new THREE.BufferGeometry());
  const sparkPositions = new Float32Array(PARTICLES * 3);
  const sparkColors = new Float32Array(PARTICLES * 3);
  const sparkVelocity = new Float32Array(PARTICLES * 3);
  const sparkLife = new Float32Array(PARTICLES);
  const sparkTint = new Float32Array(PARTICLES * 3);
  sparkGeometry.setAttribute("position", new THREE.BufferAttribute(sparkPositions, 3));
  sparkGeometry.setAttribute("color", new THREE.BufferAttribute(sparkColors, 3));
  const sparks = new THREE.Points(sparkGeometry, pointsMaterial(0.22));
  sparks.frustumCulled = false;
  scene.add(sparks);
  let nextSpark = 0;

  const flyGeometry = keep(new THREE.BufferGeometry());
  const flyPositions = new Float32Array(FIREFLIES * 3);
  const flyColors = new Float32Array(FIREFLIES * 3);
  const flySeeds = Float32Array.from({ length: FIREFLIES * 4 }, () => random());
  flyGeometry.setAttribute("position", new THREE.BufferAttribute(flyPositions, 3));
  flyGeometry.setAttribute("color", new THREE.BufferAttribute(flyColors, 3));
  const flies = new THREE.Points(flyGeometry, pointsMaterial(0.18));
  flies.frustumCulled = false;
  scene.add(flies);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(back, camera));
  for (const target of [scene, front]) {
    const pass = new RenderPass(target, camera);
    pass.clear = false;
    pass.clearDepth = true;
    composer.addPass(pass);
  }
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.3, 0.82);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // --- Score overlay ---
  const hud = document.createElement("div");
  hud.setAttribute("aria-hidden", "true");
  hud.style.cssText =
    "position:absolute;inset:0;pointer-events:none;z-index:5;container-type:size;font-family:'Arial Black',Impact,system-ui,sans-serif;color:#fff";
  hud.innerHTML = `<style>
    .jh-score{position:absolute;left:3cqw;bottom:6cqh;font-size:5.2cqh;letter-spacing:.04em;color:#ffe9a8;
      -webkit-text-stroke:.35cqh #2a1400;paint-order:stroke fill;text-shadow:0 0 2cqh rgba(255,190,60,.55)}
    .jh-mult{position:absolute;left:3cqw;bottom:13cqh;width:9cqh;height:9cqh;border-radius:50%;display:grid;place-items:center;
      font-size:4cqh;background:radial-gradient(#1b3a12,#071406);border:.6cqh solid #7dff3a;box-shadow:0 0 2.5cqh #7dff3a}
    .jh-streak{position:absolute;right:3cqw;bottom:6cqh;font-size:3cqh;text-align:right;color:#bfffd0;
      -webkit-text-stroke:.25cqh #021a0a;paint-order:stroke fill}
    .jh-streak b{display:block;font-size:5.2cqh;color:#fff}
    .jh-meter{position:absolute;right:3.4cqw;top:22cqh;width:2.2cqh;height:46cqh;border-radius:2cqh;
      background:linear-gradient(#7dff3a,#ffd23a 55%,#ff3a3a);box-shadow:0 0 0 .4cqh #1a0d02,0 0 2cqh rgba(125,255,58,.4);opacity:.9}
    .jh-needle{position:absolute;left:-1.2cqh;right:-1.2cqh;height:1cqh;border-radius:1cqh;background:#fff;box-shadow:0 0 1.5cqh #fff;transition:top .25s}
    .jh-label{position:absolute;right:2.2cqw;top:16cqh;font-size:2cqh;color:#d8ffb0;letter-spacing:.12em}
    .jh-banner{position:absolute;left:0;right:0;top:12cqh;text-align:center;font-size:8cqh;color:#fff;opacity:0;
      -webkit-text-stroke:.45cqh #062a0a;paint-order:stroke fill;text-shadow:0 0 3cqh #7dff3a}
  </style>
  <div class="jh-mult">×1</div><div class="jh-score">0</div>
  <div class="jh-streak">STREAK<b>0</b></div>
  <div class="jh-label">JUNGLE</div><div class="jh-meter"><div class="jh-needle"></div></div>
  <div class="jh-banner"></div>`;
  renderer.domElement.after(hud);
  const $ = (selector: string) => hud.querySelector<HTMLElement>(selector)!;
  const scoreEl = $(".jh-score"),
    multEl = $(".jh-mult"),
    streakEl = $(".jh-streak b"),
    needle = $(".jh-needle"),
    banner = $(".jh-banner");
  const shout = (text: string, color = "#7dff3a") => {
    banner.textContent = text;
    banner.style.textShadow = `0 0 3cqh ${color}`;
    banner.animate(
      [
        { opacity: 0, transform: "scale(.6)" },
        { opacity: 1, transform: "scale(1.08)", offset: 0.15 },
        { opacity: 1, transform: "scale(1)", offset: 0.7 },
        { opacity: 0, transform: "scale(1.15)" },
      ],
      { duration: 1600, easing: "ease-out" },
    );
  };

  // --- State ---
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let target: VisualLook = { ...DEFAULT_VISUAL_LOOK };
  const look = { ...target };
  let lanes: MusicLane[] = [];
  const charts = new Map<string, Chart>();
  let idle: Chart | undefined;
  let idleClock = 0;
  let width = 0,
    height = 0,
    pixelRatio = 0;
  let previous: number | undefined;
  let sceneTime = 0;
  let sourceKey = "",
    lastSongTime = 0,
    lastStyle: Style | undefined;
  let score = 0,
    streak = 0,
    meter = 0.5,
    fever = 0,
    pulse = 0,
    bump = 0,
    lastFret = -1;
  let shownScore = -1,
    shownStreak = -1,
    shownMult = -1;
  let statusText = "";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const forward = new THREE.Vector3();
  const up = new THREE.Vector3();
  const point = new THREE.Vector3();

  const chartFor = (lane: MusicLane): Chart | undefined => {
    if (!lane.trackId || !lane.waveform?.peaks.length) return undefined;
    let chart = charts.get(lane.trackId);
    if (!chart) {
      chart = buildChart(lane.waveform, lane.bpm);
      charts.set(lane.trackId, chart);
      if (charts.size > 8) charts.delete(charts.keys().next().value!);
    }
    return chart;
  };

  /** Follow the loudest playing deck; a loaded but paused deck still shows its chart. */
  const pickSource = (dt: number): Source => {
    let best: MusicLane | undefined,
      bestIndex = -1;
    lanes.forEach((lane, i) => {
      if (!lane.waveform?.peaks.length || !lane.trackId) return;
      const rank = (lane.playing ? 10 : 0) + lane.level;
      const bestRank = best ? (best.playing ? 10 : 0) + best.level : -1;
      if (rank > bestRank) ((best = lane), (bestIndex = i));
    });
    const chart = best && chartFor(best);
    if (best && chart)
      return {
        key: `${bestIndex}:${best.trackId}`,
        chart,
        time: best.time,
        label: `Deck ${bestIndex + 1}`,
      };
    idle ??= buildChart(idleWaveform(), 124);
    idleClock += dt;
    return { key: "idle", chart: idle, time: idleClock % idle.song.duration, label: "Demo chart" };
  };

  const lowerBound = (items: { time: number }[], time: number) => {
    let low = 0,
      high = items.length;
    while (low < high) {
      const m = (low + high) >> 1;
      if (items[m]!.time < time) low = m + 1;
      else high = m;
    }
    return low;
  };

  const spawn = (x: number, tint: THREE.Color, count: number, power: number) => {
    for (let k = 0; k < count; k++) {
      const i = nextSpark;
      nextSpark = (nextSpark + 1) % PARTICLES;
      const angle = Math.random() * Math.PI * 2;
      const spread = (0.6 + Math.random() * 1.8) * power;
      sparkPositions.set(
        [x + (Math.random() - 0.5) * 0.5, 0.15, (Math.random() - 0.5) * 0.3],
        i * 3,
      );
      sparkVelocity.set(
        [
          Math.cos(angle) * spread,
          (2.5 + Math.random() * 4) * power,
          Math.sin(angle) * spread * 0.5,
        ],
        i * 3,
      );
      const white = Math.random() < 0.3 ? 1 : 0;
      sparkTint.set([white || tint.r * 1.6, white || tint.g * 1.6, white || tint.b * 1.6], i * 3);
      sparkLife[i] = 0.5 + Math.random() * 0.5;
    }
  };

  const press = new Float32Array(NOTE_LANES);
  const holding = new Uint8Array(NOTE_LANES);
  const hit = (note: Note) => {
    hits[note.lane] = 1;
    press[note.lane] = 1;
    // Only big notes send out a shockwave, so it still means something.
    if (note.big) {
      waveLane[nextWave] = note.lane;
      waveAge[nextWave] = 0;
      waveBig[nextWave] = 1;
      nextWave = (nextWave + 1) % WAVES;
    }
    spawn(laneX(note.lane), laneColors[note.lane]!, note.big ? 24 : 6, note.big ? 1.3 : 0.8);
    if (note.big) pulse = 1;
    streak++;
    const multiplier = Math.min(4, 1 + Math.floor(streak / 10));
    score += (note.big ? 100 : 50) * multiplier * (fever > 0.5 ? 2 : 1);
    if (STREAKS.includes(streak)) shout(`${streak} NOTE STREAK!`, "#ffd23a");
  };

  const resize = () => {
    const bounds = host.getBoundingClientRect();
    const w = Math.max(1, bounds.width),
      h = Math.max(1, bounds.height);
    const ratio = Math.min(devicePixelRatio, 1.5, Math.sqrt(1_800_000 / (w * h)));
    if (w === width && h === height && ratio === pixelRatio) return;
    width = w;
    height = h;
    pixelRatio = ratio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(ratio);
    composer.setSize(w, h);
    const aspect = w / h;
    // Narrow screens step back so the whole highway still fits.
    const narrow = Math.max(0, 1.4 - aspect);
    for (const cam of [camera, base]) {
      cam.aspect = aspect;
      cam.fov = 50 + narrow * 14;
      cam.updateProjectionMatrix();
    }
    base.position.set(0, 4.2 + narrow * 2.5, 6.2 + narrow * 5);
    base.lookAt(0, 0, -11);
    base.updateMatrixWorld();
    // Each backdrop layer faces the camera and covers the view at its own depth.
    base.getWorldDirection(forward);
    up.set(0, 1, 0).applyQuaternion(base.quaternion);
    const tan = Math.tan(THREE.MathUtils.degToRad(base.fov / 2));
    for (const layer of layers) {
      const viewH = 2 * tan * layer.distance,
        viewW = viewH * aspect;
      const s = Math.max(viewW / 2, viewH) * layer.margin;
      layer.mesh.scale.set(s, s, 1);
      layer.mesh.quaternion.copy(base.quaternion);
      layer.mesh.position.copy(base.position).addScaledVector(forward, layer.distance);
    }
    const jaguarDistance = 110;
    const viewH = 2 * tan * jaguarDistance;
    jaguar.scale.set(viewH * 0.24, viewH * 0.24, 1);
    jaguar.quaternion.copy(base.quaternion);
    jaguar.position
      .copy(base.position)
      .addScaledVector(forward, jaguarDistance)
      .addScaledVector(up, viewH * 0.3);
    mid.mesh.updateMatrixWorld();
    eyeSpots.forEach((spot, i) => {
      for (const side of [0, 1]) {
        point.set((spot.u - 0.5) * 2 + (side ? 0.012 : -0.012), 0.5 - spot.v, 0.001);
        mid.mesh.localToWorld(point);
        point.toArray(eyePositions, (i * 2 + side) * 3);
      }
    });
    eyeGeometry.attributes.position!.needsUpdate = true;
  };

  return {
    setLook(next) {
      target = next;
    },
    setMusic(next) {
      lanes = next;
    },
    status() {
      return statusText;
    },
    draw(time, _rgba, energy) {
      resize();
      const dt = previous === undefined ? 0 : Math.min(0.05, Math.max(0, time - previous));
      previous = time;
      const blend = 1 - Math.exp(-dt * 2);
      for (const key of ["intensity", "motion", "density", "halloween"] as const)
        look[key] += (target[key] - look[key]) * blend;
      const calm = reduced.matches ? 0.15 : 1;
      sceneTime += dt;
      const intensity = look.intensity;

      const source = pickSource(dt);
      const { chart } = source;
      const now = source.time;
      const speed = SPEED * THREE.MathUtils.clamp(0.55 + 0.45 * look.motion, 0.4, 1.5);
      const ahead = (LENGTH - NEAR) / speed;
      // The chart is already paced for play; the density slider only thins it below full.
      const cutoff = THREE.MathUtils.clamp(1 - look.density, 0, 0.9);
      const visible = (note: Note) => note.big || note.rank >= cutoff;

      // Score every note that crossed the strike line since the last frame; a seek or a
      // track change just moves the playhead.
      const jumped = source.key !== sourceKey || now < lastSongTime || now - lastSongTime > 0.5;
      if (!jumped) {
        for (let i = lowerBound(chart.notes, lastSongTime); i < chart.notes.length; i++) {
          const note = chart.notes[i]!;
          if (note.time > now) break;
          if (note.time > lastSongTime && visible(note)) hit(note);
        }
      } else if (source.key !== sourceKey) streak = 0;
      sourceKey = source.key;
      lastSongTime = now;

      const section = sectionAt(chart.song, now);
      const style = section?.style ?? "groove";
      if (style !== lastStyle && !jumped) {
        if (style === "drop") shout("JUNGLE FEVER!", "#7dff3a");
        else if (style === "build") shout("BUILD UP", "#ffd23a");
      }
      lastStyle = style;
      fever += ((style === "drop" ? 1 : 0) - fever) * (1 - Math.exp(-dt * 3));
      let bar = 0;
      while (bar < chart.song.bars.length - 1 && chart.song.bars[bar + 1]! <= now) bar++;
      meter += ((chart.song.energy[bar] ?? 0.5) - meter) * (1 - Math.exp(-dt * 1.5));

      // Live audio, for the shimmer between notes.
      let loudest = 0;
      for (let k = 1; k < 3; k++)
        if ((energy[k * 4] ?? 0) > (energy[loudest * 4] ?? 0)) loudest = k;
      const low = Math.min(1, energy[loudest * 4 + 1] ?? 0);

      // Hold notes keep their pad lit and sparking, and their button held down.
      holding.fill(0);
      let holdIndex = lowerBound(chart.notes, now - 8);
      for (; holdIndex < chart.notes.length; holdIndex++) {
        const note = chart.notes[holdIndex]!;
        if (note.time > now) break;
        if (note.length && note.time + note.length > now && visible(note)) {
          hits[note.lane] = Math.max(hits[note.lane]!, 0.7);
          holding[note.lane] = 1;
          if (Math.random() < dt * 30) spawn(laneX(note.lane), laneColors[note.lane]!, 1, 0.6);
        }
      }

      // --- Notes, tails and frets on the highway ---
      let gems = 0,
        rings = 0,
        tailCount = 0;
      for (
        let i = lowerBound(chart.notes, now - 8);
        i < chart.notes.length && gems < MAX_NOTES;
        i++
      ) {
        const note = chart.notes[i]!;
        if (note.time > now + ahead) break;
        if (!visible(note)) continue;
        const z = -(note.time - now) * speed;
        const x = laneX(note.lane);
        const laneColor = laneColors[note.lane]!;
        if (note.length && note.time + note.length > now) {
          const zEnd = -(note.time + note.length - now) * speed;
          const zStart = Math.min(0, z);
          const span = Math.max(0.01, zStart - Math.max(zEnd, -(LENGTH - NEAR)));
          const held = note.time <= now;
          dummy.position.set(
            x + (held ? Math.sin(sceneTime * 40) * 0.03 : 0),
            0.06,
            zStart - span / 2,
          );
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(held ? 0.24 : 0.17, 0.05, span);
          dummy.updateMatrix();
          tails.setMatrixAt(tailCount, dummy.matrix);
          tails.setColorAt(tailCount++, color.copy(laneColor).multiplyScalar(held ? 1.6 : 0.9));
        }
        // A struck gem squashes flat into its button for a moment instead of vanishing.
        const struck = clamp01((now - note.time) / ABSORB);
        if (note.time <= now && struck >= 1) continue;
        const bob = note.big && !struck ? 0.06 + Math.sin(sceneTime * 6 + note.time) * 0.04 : 0;
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(note.big ? 1.18 : 1);
        if (struck > 0) dummy.scale.set(1 + struck * 0.5, Math.max(0.05, 1 - struck), 1 + struck * 0.5);
        dummy.position.set(x, 0.05 + bob, Math.min(0, z));
        dummy.updateMatrix();
        gemBase.setMatrixAt(gems, dummy.matrix);
        dummy.position.y = 0.16 + bob;
        dummy.updateMatrix();
        gemBody.setMatrixAt(gems, dummy.matrix);
        gemBody.setColorAt(gems, color.copy(laneColor).multiplyScalar(note.big ? 1.1 : 0.85));
        dummy.position.y = 0.2 + bob;
        dummy.updateMatrix();
        gemCap.setMatrixAt(gems, dummy.matrix);
        gemCap.setColorAt(
          gems,
          note.big ? color.setRGB(1.4, 1.2, 0.6) : color.setRGB(0.9, 0.9, 0.9),
        );
        gems++;
        if (note.big) {
          dummy.position.y = 0.18 + bob;
          dummy.scale.setScalar(1.18 + Math.sin(sceneTime * 8 + note.time) * 0.08);
          dummy.updateMatrix();
          bigRing.setMatrixAt(rings, dummy.matrix);
          bigRing.setColorAt(rings++, color.setRGB(1.6, 1.15, 0.3));
        }
      }
      gemBase.count = gemBody.count = gemCap.count = gems;
      bigRing.count = rings;
      tails.count = tailCount;

      let fretCount = 0;
      for (
        let i = lowerBound(chart.frets, now - 0.2);
        i < chart.frets.length && fretCount < MAX_FRETS;
        i++
      ) {
        const fret = chart.frets[i]!;
        if (fret.time > now + ahead) break;
        const z = -(fret.time - now) * speed;
        if (z > NEAR - 0.5) continue;
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(0, 0.012, z);
        dummy.scale.set(HIGHWAY_WIDTH, 0.02, fret.downbeat ? 0.1 : 0.04);
        dummy.updateMatrix();
        frets.setMatrixAt(fretCount, dummy.matrix);
        const strength = fret.downbeat ? 0.55 : 0.22;
        frets.setColorAt(fretCount++, color.setRGB(strength * 0.8, strength, strength * 0.7));
      }
      frets.count = fretCount;
      for (const mesh of [gemBase, gemBody, gemCap, bigRing, tails, frets]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }

      // A downbeat nudges the camera and the jungle.
      const fretIndex = lowerBound(chart.frets, now + 0.0001) - 1;
      if (fretIndex !== lastFret && fretIndex >= 0 && !jumped && chart.frets[fretIndex]?.downbeat)
        bump = 1;
      lastFret = fretIndex;
      bump *= Math.exp(-dt * 6);
      pulse *= Math.exp(-dt * 4);

      // --- Targets ---
      targets.forEach((t, lane) => {
        hits[lane] = hits[lane]! * Math.exp(-dt * 7);
        const h = hits[lane]!;
        t.ring.scale.setScalar(1 + h * 0.25);
        (t.ring.material as THREE.MeshBasicMaterial).color
          .copy(t.color)
          .multiplyScalar(1 + h * 0.8);
        (t.pad.material as THREE.MeshBasicMaterial).color
          .copy(t.color)
          .multiplyScalar(0.12 + h * 1.2);
        t.beamMaterial.uniforms.strength!.value = h * intensity;
        press[lane] = press[lane]! * Math.exp(-dt * 16);
        const p = Math.max(press[lane]!, holding[lane]! ? 0.75 : 0);
        t.button.position.y = BUTTON_Y - p * 0.085;
        t.button.scale.set(1 + p * 0.1, 1 - p * 0.35, 1 + p * 0.1);
        (t.button.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.15 + p * 1.8;
      });

      let waveCount = 0;
      for (let i = 0; i < WAVES; i++) {
        if (!(waveAge[i]! < 0.4)) continue;
        waveAge[i] = waveAge[i]! + dt;
        const k = waveAge[i]! / 0.4;
        dummy.rotation.set(0, 0, 0);
        dummy.position.set(laneX(waveLane[i]!), 0.06, 0);
        dummy.scale.setScalar(1 + k * (waveBig[i] ? 3.2 : 1.6));
        dummy.updateMatrix();
        waves.setMatrixAt(waveCount, dummy.matrix);
        waves.setColorAt(
          waveCount++,
          color.copy(laneColors[waveLane[i]!]!).multiplyScalar(Math.pow(1 - clamp01(k), 2) * (waveBig[i] ? 3 : 2)),
        );
      }
      waves.count = waveCount;
      waves.instanceMatrix.needsUpdate = true;
      if (waves.instanceColor) waves.instanceColor.needsUpdate = true;

      // --- Sparks ---
      for (let i = 0; i < PARTICLES; i++) {
        if (sparkLife[i]! <= 0) {
          sparkColors[i * 3] = sparkColors[i * 3 + 1] = sparkColors[i * 3 + 2] = 0;
          continue;
        }
        sparkLife[i] = sparkLife[i]! - dt;
        sparkVelocity[i * 3 + 1] = sparkVelocity[i * 3 + 1]! - dt * 9;
        for (let c = 0; c < 3; c++)
          sparkPositions[i * 3 + c] = sparkPositions[i * 3 + c]! + sparkVelocity[i * 3 + c]! * dt;
        const fade = Math.max(0, Math.min(1, sparkLife[i]! * 2));
        for (let c = 0; c < 3; c++)
          sparkColors[i * 3 + c] = sparkTint[i * 3 + c]! * fade * intensity;
      }
      sparkGeometry.attributes.position!.needsUpdate = true;
      sparkGeometry.attributes.color!.needsUpdate = true;

      // --- Fireflies drift beside the highway and flare with the highs ---
      const highs = Math.min(1, (energy[loudest * 4 + 3] ?? 0) * 2);
      const flyCount = Math.round(
        FIREFLIES * THREE.MathUtils.clamp(0.3 + look.density * 0.5, 0.2, 1),
      );
      for (let i = 0; i < FIREFLIES; i++) {
        const a = flySeeds[i * 4]!,
          b = flySeeds[i * 4 + 1]!,
          c = flySeeds[i * 4 + 2]!,
          d = flySeeds[i * 4 + 3]!;
        const side = a < 0.5 ? -1 : 1;
        const t = sceneTime * (0.15 + d * 0.2) * calm;
        flyPositions[i * 3] = side * (4.2 + b * 14) + Math.sin(t * 3 + c * 9) * 0.8;
        flyPositions[i * 3 + 1] = 0.4 + c * 6 + Math.sin(t * 2.3 + a * 7) * 0.6;
        flyPositions[i * 3 + 2] = 3 - d * 40 + Math.cos(t * 1.7 + b * 5) * 0.8;
        const flicker = Math.max(0, Math.sin(sceneTime * (1.5 + a * 3) + d * 20)) ** 3;
        const on =
          i < flyCount ? (0.25 + flicker * 0.9 + highs * 0.4 + fever * 0.3) * intensity : 0;
        flyColors[i * 3] = 0.75 * on;
        flyColors[i * 3 + 1] = 1.1 * on;
        flyColors[i * 3 + 2] = 0.3 * on;
      }
      flyGeometry.attributes.position!.needsUpdate = true;
      flyGeometry.attributes.color!.needsUpdate = true;

      // --- Jungle eyes blink, and wake up as the song gets louder ---
      eyeSpots.forEach((spot, i) => {
        spot.next -= dt;
        const awake = meter + fever * 0.5 > spot.awake;
        if (spot.next <= 0) spot.next = 1.5 + Math.random() * 5;
        const blinking = spot.next < 0.14;
        const goal = awake && !blinking ? 1 : 0;
        spot.open += (goal - spot.open) * (1 - Math.exp(-dt * (blinking ? 30 : 3)));
        const strength = spot.open * (1.2 + pulse * 1.5) * intensity;
        for (const side of [0, 1])
          color
            .copy(spot.color)
            .multiplyScalar(strength)
            .toArray(eyeColors, (i * 2 + side) * 3);
      });
      eyeGeometry.attributes.color!.needsUpdate = true;
      const blink = sceneTime % 7.3 < 0.18 ? 0.1 : 1;
      jaguarMaterial.uniforms.open!.value +=
        (fever * blink - jaguarMaterial.uniforms.open!.value) *
        (1 - Math.exp(-dt * (blink < 1 ? 25 : 2.5)));
      jaguarMaterial.uniforms.glow!.value = pulse * 0.8 + bump * 0.3;
      jaguarMaterial.uniforms.look!.value = Math.sin(sceneTime * 0.4) * 0.6;

      for (const layer of layers) {
        layer.material.uniforms.time!.value = sceneTime;
        layer.material.uniforms.sway!.value = (0.6 + low * 1.2 + bump * 0.8) * calm * look.motion;
      }
      sky.material.uniforms.glow!.value =
        (0.12 + pulse * 0.4 + bump * 0.15 + fever * 0.12) * intensity;
      sky.material.uniforms.light!.value = 0.9 + pulse * 0.25;
      far.material.uniforms.light!.value = 0.95 + bump * 0.15;
      mid.material.uniforms.light!.value = 1 + bump * 0.25 + fever * 0.1;
      near.material.uniforms.light!.value = 1 + pulse * 0.6;

      highwayMaterial.uniforms.scroll!.value = (now * speed) % 1000;
      highwayMaterial.uniforms.time!.value = sceneTime;
      highwayMaterial.uniforms.fever!.value = fever;
      highwayMaterial.uniforms.pulse!.value = pulse + bump * 0.5;

      // The camera sways a little so the jungle layers slide past each other.
      camera.position.copy(base.position);
      camera.position.x += Math.sin(sceneTime * 0.21) * 0.35 * calm;
      camera.position.y += bump * 0.06 * calm + Math.sin(sceneTime * 0.33) * 0.12 * calm;
      camera.lookAt(Math.sin(sceneTime * 0.21) * 0.15 * calm, 0, -11);

      bloom.strength = (0.4 + pulse * 0.35 + fever * 0.1) * Math.min(1.6, intensity);
      renderer.toneMappingExposure = 1.05 + intensity * 0.1;

      // --- Overlay ---
      const multiplier = Math.min(4, 1 + Math.floor(streak / 10));
      if (score !== shownScore) scoreEl.textContent = (shownScore = score).toLocaleString("en-US");
      if (streak !== shownStreak) streakEl.textContent = String((shownStreak = streak));
      if (multiplier !== shownMult) {
        shownMult = multiplier;
        multEl.textContent = `×${multiplier}`;
        const ring = MULTIPLIER_COLORS[multiplier - 1]!;
        multEl.style.borderColor = ring;
        multEl.style.boxShadow = `0 0 2.5cqh ${ring}`;
      }
      needle.style.top = `${(1 - Math.min(1, meter)) * 100}%`;
      hud.style.opacity = String(Math.min(1, intensity * 1.5));

      statusText = `${source.label} · ${style} · ${gems} notes ahead · ×${multiplier}`;
      composer.render(dt);
    },
    dispose() {
      composer.dispose();
      for (const item of disposables) item.dispose();
      for (const mesh of [gemBase, gemBody, gemCap, bigRing, tails, frets, waves]) mesh.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      hud.remove();
    },
  };
}
