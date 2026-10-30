import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { DEFAULT_VISUAL_LOOK, type VisualLook } from "../../../dj-monitor/src/visual-presets.js";
import { analyzeSong, idleSong, sectionAt, type SongMap, type Style } from "../music/song-map.js";
import type { MusicLane, SceneEngine } from "../scenes.js";
import { ACTOR_KINDS, createActor, disposeActor, type Actor, type ActorKind } from "./corn-maze-actors.js";
import { CELL, Maze } from "./corn-maze-path.js";

const LANES = 3;
const MAX_STALKS = 6000;
const MAX_PUMPKINS = 120;
const MIST = 260;
/** Path cells kept grown behind and ahead of the walker. */
const BEHIND = 3;
const AHEAD = 15;
const EYE = 1.6;
const MIN_GAP = 7;

/** Walking pace per section, in metres per second: a stroll in breakdowns, hurrying on drops. */
const PACE: Record<Style, number> = { break: 0.9, vocal: 1.4, groove: 1.7, build: 2.1, drop: 2.5 };

/**
 * How each actor scares: bursting out of the wall beside you, rushing at you down the
 * corridor, swooping over the corn, or standing there when the flashlight comes back on.
 */
type Mode = "side" | "rush" | "swoop" | "blackout";
const MODE: Record<ActorKind, Mode> = {
  skeleton: "side",
  pumpkin: "side",
  ghost: "rush",
  witch: "swoop",
  shadow: "blackout",
};
/** Seconds of warning (rustling corn, a flickering light) before the scare lands on its beat. */
const LEAD: Record<Mode, number> = { side: 1.4, rush: 1.5, swoop: 1.0, blackout: 1.6 };
/** Seconds after the scare lands until the actor is gone again. */
const LENGTH: Record<Mode, number> = { side: 1.9, rush: 0.4, swoop: 1.7, blackout: 1.4 };

type Scare = { at: number; kind: ActorKind; big: boolean };
type Active = {
  actor: Actor;
  mode: Mode;
  /** Scene clock when the scare lands. */
  start: number;
  side: number;
  /** Distance along the path where the actor hides. */
  anchor: number;
  big: boolean;
  struck: boolean;
};

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** Fewer scares as the Halloween slider comes down; drops always get one. */
function scareEvery(halloween: number) {
  return halloween >= 0.85 ? 8 : halloween >= 0.5 ? 16 : halloween >= 0.2 ? 32 : 0;
}

/**
 * Scares placed on the song: every drop, every odd fill or dropout, and one every few bars
 * through the rest, never closer together than MIN_GAP seconds.
 */
function planScares(song: SongMap, every: number): Scare[] {
  const big = song.sections.filter((s) => s.style === "drop").map((s) => s.start);
  const small = [...song.swirls];
  if (every)
    song.bars.forEach((bar, i) => {
      if (i % every === every / 2 && sectionAt(song, bar)?.style !== "break") small.push(bar);
    });
  const accepted: { at: number; big: boolean }[] = [];
  const fits = (at: number) => accepted.every((s) => Math.abs(s.at - at) >= MIN_GAP);
  for (const at of big) if (fits(at)) accepted.push({ at, big: true });
  for (const at of small.sort((a, b) => a - b)) if (at > 4 && fits(at)) accepted.push({ at, big: false });
  accepted.sort((a, b) => a.at - b.at);
  // Take the actors in turn, starting somewhere different for each song, so none comes twice running.
  const first = Math.floor(hash(song.duration) * ACTOR_KINDS.length);
  return accepted.map((s, i) => ({ ...s, kind: ACTOR_KINDS[(first + i) % ACTOR_KINDS.length]! }));
}

/** A dry late-October cornstalk, about three metres tall, with drooping leaves and a tassel. */
function stalkGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  const paint = (geometry: THREE.BufferGeometry, color: (y: number) => THREE.Color) => {
    const position = geometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) color(position.getY(i)).toArray(colors, i * 3);
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    parts.push(geometry);
  };
  const base = new THREE.Color(0x4f4220),
    top = new THREE.Color(0x9c8b4c),
    green = new THREE.Color(0x6c7a32),
    dry = new THREE.Color(0xb7a462),
    color = new THREE.Color();

  const stem = new THREE.CylinderGeometry(0.018, 0.032, 3, 5, 6).translate(0, 1.5, 0);
  paint(stem, (y) => color.lerpColors(base, top, y / 3));
  for (let k = 0; k < 8; k++) {
    const leaf = new THREE.PlaneGeometry(0.1, 1, 1, 6);
    const position = leaf.getAttribute("position") as THREE.BufferAttribute;
    const length = 0.75 + hash(k) * 0.45;
    for (let i = 0; i < position.count; i++) {
      const l = position.getY(i) + 0.5;
      const x = position.getX(i) * (1 - Math.pow(l, 1.4));
      // Out from the stem and drooping as it goes.
      position.setXYZ(i, x, -l * l * 0.5 * length, l * length);
    }
    leaf.computeVertexNormals();
    leaf.rotateX(-0.5 - hash(k + 9) * 0.4);
    leaf.rotateY(k * 2.4);
    leaf.translate(0, 0.45 + k * 0.3, 0);
    paint(leaf, () => color.lerpColors(green, dry, 0.3 + hash(k + 4) * 0.7));
  }
  const ear = new THREE.CylinderGeometry(0.045, 0.03, 0.32, 6).rotateZ(0.5).translate(0.07, 1.55, 0);
  paint(ear, () => color.set(0xa99a5c));
  for (let k = 0; k < 4; k++) {
    const tassel = new THREE.ConeGeometry(0.012, 0.42, 3).rotateZ((k - 1.5) * 0.35).translate((k - 1.5) * 0.04, 3.15, 0);
    paint(tassel, () => color.set(0xcdb571));
  }
  const merged = mergeGeometries(parts.map((p) => p.toNonIndexed()))!;
  for (const part of parts) part.dispose();
  return merged;
}

function pumpkinGeometry() {
  const shell = new THREE.SphereGeometry(0.22, 18, 12);
  const position = shell.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const ridge = 1 - 0.08 * Math.pow(Math.abs(Math.cos(Math.atan2(v.x, v.z) * 4)), 0.5);
    position.setXYZ(i, v.x * ridge * 1.15, v.y * 0.82 + 0.18, v.z * ridge * 1.15);
  }
  shell.computeVertexNormals();
  const stem = new THREE.CylinderGeometry(0.02, 0.03, 0.1, 5).translate(0, 0.39, 0);
  return mergeGeometries([shell.toNonIndexed(), stem.toNonIndexed()])!;
}

/** A jack-o'-lantern's carved face, sitting just proud of the pumpkin's front. */
function faceGeometry() {
  const parts: THREE.BufferGeometry[] = [-1, 1].map((side) => new THREE.CircleGeometry(0.05, 3).rotateZ(Math.PI / 2).translate(side * 0.08, 0.24, 0.25));
  const grin = new THREE.Shape();
  grin.moveTo(-0.13, 0);
  for (let k = 0; k <= 6; k++) grin.lineTo(-0.13 + (k / 6) * 0.26, k % 2 ? -0.025 : 0.01);
  grin.quadraticCurveTo(0, -0.13, -0.13, 0);
  parts.push(new THREE.ShapeGeometry(grin).translate(0, 0.14, 0.255));
  return mergeGeometries(parts.map((p) => p.toNonIndexed()))!;
}

function dirtTexture() {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const n = 0.55 + Math.random() * 0.45 * (Math.random() < 0.1 ? 0.4 : 1);
    data.set([150 * n, 116 * n, 82 * n, 255], i * 4);
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Walk through a haunted corn maze at night by flashlight. The song sets the pace, and on its
 * drops and fills actors jump out of the corn: skeletons, ghosts, witches, a pumpkin-headed
 * scarecrow and something tall that waits for the light to go out.
 */
export async function createCornMaze(host: HTMLCanvasElement): Promise<SceneEngine> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  const fogColor = new THREE.Color(0x0a0912);
  renderer.setClearColor(fogColor, 1);
  host.after(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(fogColor, 0.075);
  const camera = new THREE.PerspectiveCamera(68, 1, 0.05, 260);
  scene.add(camera);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(item: T) => (disposables.push(item), item);

  // Moonlight from above and a handheld flashlight that does most of the work.
  const moonDirection = new THREE.Vector3(-0.35, 0.55, -0.75).normalize();
  const hemisphere = new THREE.HemisphereLight(0x4a5a9a, 0x140e08, 0.6);
  const moon = new THREE.DirectionalLight(0x8ea0ff, 0.35);
  moon.position.copy(moonDirection).multiplyScalar(50);
  scene.add(hemisphere, moon, moon.target);
  const flashlight = new THREE.SpotLight(0xffe0b0, 7, 0, 0.55, 0.55, 1.2);
  flashlight.position.set(0.22, -0.25, 0.1);
  flashlight.target.position.set(0, -0.6, -6);
  camera.add(flashlight, flashlight.target);

  // Sky: a dark gradient, a hazy moon and slow clouds, following the camera.
  const skyMaterial = keep(
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { time: { value: 0 }, moon: { value: moonDirection }, flash: { value: 0 }, haze: { value: fogColor } },
      vertexShader: /* glsl */ `varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */ `uniform float time, flash; uniform vec3 moon, haze; varying vec3 vDir;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        void main() {
          vec3 d = normalize(vDir);
          float up = clamp(d.y, 0., 1.);
          vec3 color = mix(vec3(.07, .055, .11), vec3(.008, .01, .03), pow(up, .6));
          vec2 p = d.xz / (d.y + .25) * 2. + vec2(time * .03, 0.);
          float cloud = smoothstep(.45, .85, noise(p) * .6 + noise(p * 2.3) * .3 + noise(p * 5.1) * .1);
          float m = dot(d, moon);
          float disc = smoothstep(.9993, .9996, m);
          float halo = pow(max(0., m), 60.) * .5 + pow(max(0., m), 6.) * .08;
          vec3 moonlight = vec3(.85, .88, 1.) * (disc * 2.2 + halo);
          color += moonlight * (1. - cloud * .75);
          color = mix(color, vec3(.09, .08, .13) + halo * .4, cloud * .55);
          float stars = step(.997, hash(floor(d.xz / (d.y + .3) * 220.))) * (1. - cloud) * up;
          color += stars * .6;
          color += flash * vec3(.55, .6, .9) * (.4 + cloud);
          // Melt into the fog at the horizon, where the ground ends.
          color = mix(haze, color, smoothstep(.0, .22, d.y));
          gl_FragColor = vec4(color, 1.);
        }`,
    }),
  );
  const sky = new THREE.Mesh(keep(new THREE.SphereGeometry(200, 32, 16)), skyMaterial);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  scene.add(sky);

  const dirt = keep(dirtTexture());
  dirt.repeat.set(48, 48);
  const ground = new THREE.Mesh(
    keep(new THREE.PlaneGeometry(192, 192).rotateX(-Math.PI / 2)),
    keep(new THREE.MeshLambertMaterial({ color: 0xffffff, map: dirt })),
  );
  scene.add(ground);

  // The corn sways in the wind, shivers with the kick, and thrashes where something is hiding.
  const cornUniforms = {
    time: { value: 0 },
    gust: { value: 0 },
    rustle: { value: 0 },
    rustleAt: { value: new THREE.Vector3() },
  };
  const cornMaterial = keep(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  cornMaterial.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, cornUniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float time, gust, rustle; uniform vec3 rustleAt;")
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        vec3 root = (modelMatrix * instanceMatrix * vec4(0., 0., 0., 1.)).xyz;
        float bend = pow(max(position.y, 0.) / 3., 2.);
        float wind = sin(time * 1.1 + root.x * .31 + root.z * .23) * .13 + sin(time * 2.7 + root.z * .9) * .04;
        vec2 away = root.xz - rustleAt.xz;
        float near = rustle * exp(-dot(away, away) * .45);
        vec2 thrash = vec2(sin(time * 29. + root.z * 9.), cos(time * 23. + root.x * 7.)) * near * .45;
        transformed.xz += (vec2(wind, wind * .5) * (1. + gust * 1.5) + thrash) * bend;`,
      );
  };
  const corn = new THREE.InstancedMesh(keep(stalkGeometry()), cornMaterial, MAX_STALKS);
  const pumpkins = new THREE.InstancedMesh(
    keep(pumpkinGeometry()),
    keep(new THREE.MeshStandardMaterial({ color: 0xc8581a, roughness: 0.6, emissive: 0x1a0600 })),
    MAX_PUMPKINS,
  );
  const faceMaterial = keep(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff9a1a).multiplyScalar(2.6) }));
  const faces = new THREE.InstancedMesh(keep(faceGeometry()), faceMaterial, MAX_PUMPKINS);
  corn.setColorAt(0, new THREE.Color(1, 1, 1));
  for (const mesh of [corn, pumpkins, faces]) {
    mesh.frustumCulled = false;
    mesh.count = 0;
    scene.add(mesh);
  }

  // Low mist drifting between the walls.
  const mistMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { pixelRatio: { value: 1 }, strength: { value: 1 } },
      vertexShader: /* glsl */ `attribute float size; uniform float pixelRatio; varying float vFade;
        void main() {
          vec4 view = modelViewMatrix * vec4(position, 1.);
          float d = -view.z;
          vFade = smoothstep(.5, 3., d) * (1. - smoothstep(10., 22., d));
          gl_PointSize = size * pixelRatio * 260. / max(d, .5);
          gl_Position = projectionMatrix * view;
        }`,
      fragmentShader: /* glsl */ `uniform float strength; varying float vFade;
        void main() {
          float d = length(gl_PointCoord - .5) * 2.;
          gl_FragColor = vec4(.55, .58, .72, pow(max(0., 1. - d), 2.5) * .045 * vFade * strength);
        }`,
    }),
  );
  const mistGeometry = keep(new THREE.BufferGeometry());
  const mistPosition = new THREE.BufferAttribute(new Float32Array(MIST * 3), 3).setUsage(THREE.DynamicDrawUsage);
  mistGeometry.setAttribute("position", mistPosition);
  mistGeometry.setAttribute(
    "size",
    new THREE.BufferAttribute(Float32Array.from({ length: MIST }, () => 1.5 + Math.random() * 2.5), 1),
  );
  const mist = new THREE.Points(mistGeometry, mistMaterial);
  mist.frustumCulled = false;
  scene.add(mist);
  const mistSeeds = Array.from({ length: MIST }, () => ({
    x: (Math.random() - 0.5) * 30,
    z: (Math.random() - 0.5) * 30,
    y: 0.35 + Math.random() * 0.9,
    speed: 0.1 + Math.random() * 0.25,
  }));

  const actors = new Map<ActorKind, Actor>(ACTOR_KINDS.map((kind) => [kind, createActor(kind)]));
  for (const actor of actors.values()) scene.add(actor.root);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.8, 0.5, 1.1);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  // Vignette, film grain, and the red or white flash of a scare.
  const fright = new ShaderPass({
    uniforms: {
      tDiffuse: { value: null },
      time: { value: 0 },
      flash: { value: 0 },
      flashColor: { value: new THREE.Color() },
      split: { value: 0 },
      dark: { value: 0 },
    },
    vertexShader: /* glsl */ `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: /* glsl */ `uniform sampler2D tDiffuse; uniform float time, flash, split, dark; uniform vec3 flashColor;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec2 c = vUv - .5;
        float r = dot(c, c);
        vec2 shift = c * split * (.02 + r * .08);
        vec3 color = vec3(texture2D(tDiffuse, vUv + shift).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - shift).b);
        float vignette = smoothstep(.62, .08, r);
        color *= .25 + .75 * vignette;
        color = mix(color, flashColor, flash * (.35 + .65 * (1. - vignette * .6)));
        color *= 1. - dark;
        color += (hash(gl_FragCoord.xy + fract(time * 13.) * 91.) - .5) * .04;
        gl_FragColor = vec4(color, 1.);
      }`,
  });
  composer.addPass(fright);

  // Compile every material up front so the first scare does not stutter.
  renderer.compile(scene, camera);
  for (const actor of actors.values()) actor.root.visible = false;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const maze = new Maze(31);
  let target: VisualLook = { ...DEFAULT_VISUAL_LOOK };
  const look = { ...target };
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const point = new THREE.Vector3(),
    tangent = new THREE.Vector3(),
    right = new THREE.Vector3(),
    gaze = new THREE.Vector3(),
    wanted = new THREE.Vector3(),
    bend = new THREE.Vector3();
  let width = 0,
    height = 0,
    pixelRatio = 0,
    previous: number | undefined;
  let clock = 0;
  // Distance walked into the maze, and how fast.
  let travel = CELL,
    speed = PACE.vocal,
    sprint = 0;
  let grownAt = -1,
    grownKeep = -1;
  let gazeReady = false;
  let flash = 0,
    split = 0,
    shake = 0,
    lightning = 0,
    level = 0,
    low = 0;
  let active: Active | undefined;

  // The music the walk follows.
  const songs = new Map<string, SongMap>();
  const plans = new Map<string, Scare[]>();
  const idle = idleSong();
  let lanes: MusicLane[] = [];
  let leader = -1;
  let source = { key: "idle", song: idle, time: 0 };
  let idleTime = 0;
  let lastKey = "";
  let lastTime = 0;
  let status = "";

  const songFor = (lane: MusicLane) => {
    if (!lane.trackId || !lane.waveform) return undefined;
    let song = songs.get(lane.trackId);
    if (!song) songs.set(lane.trackId, (song = analyzeSong(lane.waveform, lane.bpm)));
    return song;
  };

  /** Follow the loudest playing deck; with nothing playing, a demo song keeps the maze haunted. */
  const chooseSource = (dt: number) => {
    let best = -1;
    lanes.forEach((lane, i) => {
      if (lane.playing && lane.waveform && (best < 0 || lane.level > lanes[best]!.level)) best = i;
    });
    const current = lanes[leader];
    if (best >= 0 && (!current?.playing || lanes[best]!.level > current.level * 1.4)) leader = best;
    const lane = lanes[leader];
    const song = lane ? songFor(lane) : undefined;
    if (lane && song && lane.playing) source = { key: lane.trackId!, song, time: lane.time };
    else {
      idleTime += dt;
      source = { key: "idle", song: idle, time: idleTime % idle.duration };
    }
  };

  const planFor = () => {
    const every = scareEvery(look.halloween);
    const id = `${source.key}:${every}`;
    let plan = plans.get(id);
    if (!plan) plans.set(id, (plan = planScares(source.song, every)));
    return plan;
  };

  /** Where along the path, and how far to its right, as a world position. */
  const placeOnPath = (along: number, lateral: number, lift: number, out: THREE.Vector3) => {
    maze.sample(along, out, tangent);
    right.set(-tangent.z, 0, tangent.x);
    return out.addScaledVector(right, lateral).setY(lift);
  };

  const growCorn = () => {
    const here = Math.floor(travel / CELL);
    const keepBelow = Math.round((0.45 + 0.55 * clamp01(look.density)) * 20) / 20;
    if (here === grownAt && keepBelow === grownKeep) return;
    if (here !== grownAt) maze.prune(here - BEHIND - 2);
    grownAt = here;
    grownKeep = keepBelow;
    let stalks = 0,
      shells = 0,
      lit = 0;
    for (const cell of maze.cells(here - BEHIND, here + AHEAD)) {
      const grown = maze.cornAround(cell);
      for (const stalk of grown.stalks) {
        if (stalk.keep > keepBelow || stalks >= MAX_STALKS) continue;
        dummy.position.set(stalk.x, 0, stalk.z);
        dummy.rotation.set(stalk.lean, stalk.turn, stalk.lean * 0.6);
        dummy.scale.set(1, stalk.height / 3, 1);
        dummy.updateMatrix();
        corn.setMatrixAt(stalks, dummy.matrix);
        color.setRGB(0.75 + stalk.tone * 0.4, 0.75 + stalk.tone * 0.3, 0.7 + (1 - stalk.tone) * 0.2);
        corn.setColorAt(stalks++, color);
      }
      for (const pumpkin of grown.pumpkins) {
        if (shells >= MAX_PUMPKINS) continue;
        dummy.position.set(pumpkin.x, 0, pumpkin.z);
        dummy.rotation.set(0, pumpkin.turn, 0);
        dummy.scale.setScalar(pumpkin.size);
        dummy.updateMatrix();
        pumpkins.setMatrixAt(shells++, dummy.matrix);
        if (pumpkin.carved) faces.setMatrixAt(lit++, dummy.matrix);
      }
    }
    corn.count = stalks;
    pumpkins.count = shells;
    faces.count = lit;
    for (const mesh of [corn, pumpkins, faces]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  };

  const startScare = (scare: Scare) => {
    if (active) {
      active.actor.root.visible = false;
      active = undefined;
    }
    const actor = actors.get(scare.kind)!;
    const mode = MODE[scare.kind];
    const lead = LEAD[mode];
    active = {
      actor,
      mode,
      start: clock + lead,
      side: hash(scare.at) < 0.5 ? -1 : 1,
      anchor: travel + speed * lead + 2.4,
      big: scare.big,
      struck: false,
    };
  };

  /** Fire scares as the song reaches each one's warning, unless the deck just jumped. */
  const scheduleScares = () => {
    const time = source.time;
    if (source.key === lastKey && time >= lastTime && time - lastTime < 1.5) {
      for (const scare of planFor()) {
        const warn = scare.at - LEAD[MODE[scare.kind]];
        if (warn > lastTime && warn <= time) startScare(scare);
      }
    }
    lastKey = source.key;
    lastTime = time;
  };

  /** What the current scare does to the world this frame. */
  const effects = { light: 1, dark: 0, slow: 1, rustle: 0, gazeAt: null as THREE.Vector3 | null };
  const playScare = () => {
    effects.light = 1;
    effects.dark = 0;
    effects.slow = 1;
    effects.rustle = 0;
    effects.gazeAt = null;
    if (!active) return;
    const { actor, mode, side } = active;
    const u = clock - active.start;
    if (u > LENGTH[mode]) {
      actor.root.visible = false;
      active = undefined;
      sprint = 1;
      return;
    }
    if (u >= 0 && !active.struck) {
      active.struck = true;
      const calm = reduced.matches ? 0.25 : 1;
      flash = (mode === "rush" ? 0.95 : 0.7) * calm;
      (fright.uniforms.flashColor!.value as THREE.Color).setHex(
        mode === "rush" ? 0xe8f2ff : mode === "swoop" ? 0x8a3cff : 0xd4140c,
      );
      split = calm;
      shake = calm;
      if (active.big) lightning = calm;
    }
    let fear = 0;
    const root = actor.root;
    const flicker = (from: number, until: number) => {
      if (u < from || u > until) return;
      const k = (u - from) / (until - from);
      if (Math.sin(clock * 47) + Math.sin(clock * 83) > 1.6 - k * 1.8) effects.light = 0.08;
    };
    switch (mode) {
      case "side": {
        // Hidden in the wall, the corn thrashing, then out at arm's length and back in.
        const out = u < 0 ? 1 : u < 0.2 ? 1 - ease(u / 0.2) : u < 1.25 ? 0 : ease((u - 1.25) / 0.55);
        const along = Math.max(active.anchor, travel + 1.5);
        placeOnPath(along, side * (0.7 + out * (CELL / 2 + 0.3)), 0, root.position);
        root.visible = true;
        fear = u < 0 ? 0 : 1 - ease((u - 1.25) / 0.55);
        if (u < 0.3) {
          effects.rustle = ease((u + LEAD.side) / LEAD.side);
          placeOnPath(active.anchor, side * (CELL / 2 + 0.6), 0, cornUniforms.rustleAt.value);
        }
        flicker(-0.5, 0);
        if (u > -0.1 && u < 1.35) effects.gazeAt = wanted.copy(root.position).setY(actor.face);
        if (u >= 0) effects.slow = u < 1.25 ? 0.12 : 1;
        break;
      }
      case "rush": {
        // Glimpsed far down the corridor, then straight through you.
        const d = u < 0 ? 1.1 + 16 * Math.pow(-u / LEAD.rush, 1.7) : 1.1 - (u / LENGTH.rush) * 2.4;
        placeOnPath(travel + d, Math.sin(clock * 2) * 0.15, 0.15 + Math.sin(clock * 3.3) * 0.08, root.position);
        root.visible = d > -0.4;
        fear = clamp01(0.3 + (u + 0.9));
        if (u > -0.9) effects.slow = 0.3;
        break;
      }
      case "swoop": {
        // Up from behind the corn on one side, down across the path, away over the other.
        const k = clamp01(u / LENGTH.swoop);
        const lateral = side * (CELL / 2 + 2) * (1 - 2 * k);
        const ahead = 6 - k * 4 + travel;
        const lift = 3.4 - Math.sin(k * Math.PI) * 2.3 - k * 0.6;
        placeOnPath(ahead, lateral, u < 0 ? 3.4 - (1 - (u + LEAD.swoop) / LEAD.swoop) * 1.5 : lift, root.position);
        root.visible = u > -LEAD.swoop * 0.6;
        fear = u < 0 ? 0.3 : 1;
        if (u < 0.2) {
          effects.rustle = 0.6;
          placeOnPath(travel + 6, side * (CELL / 2 + 0.6), 0, cornUniforms.rustleAt.value);
        }
        if (u > -0.2) effects.gazeAt = wanted.copy(root.position).setY(root.position.y + actor.face * 0.8);
        if (u >= 0) effects.slow = 0.35;
        break;
      }
      case "blackout": {
        // The light dies; when it comes back something is standing right there.
        flicker(-LEAD.blackout, -0.5);
        if (u >= -0.5 && u < 0) effects.light = 0;
        if (u >= 0.95 && u < 1.25) effects.light = 0;
        effects.dark = effects.light === 0 ? 0.85 : 0;
        const shown = u >= 0 && u < 0.95;
        root.visible = shown;
        if (shown) placeOnPath(travel + 2.9 - u * 1.5, side * 0.3, 0, root.position);
        fear = clamp01(u * 3);
        if (shown) effects.gazeAt = wanted.copy(root.position).setY(actor.face - 0.4);
        if (u >= -0.5 && u < 1.25) effects.slow = 0;
        break;
      }
    }
    root.lookAt(camera.position.x, root.position.y, camera.position.z);
    actor.pose(clock, fear * (0.85 + 0.15 * Math.sin(clock * 17)));
    // Keep trembling while it is in your face.
    if (fear > 0.5 && !reduced.matches) shake = Math.max(shake, 0.18);
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
    draw(time, _rgba, energy, motion) {
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
        mistMaterial.uniforms.pixelRatio!.value = ratio;
      }
      const dt = previous === undefined ? 0 : Math.min(0.05, Math.max(0, time - previous));
      previous = time;
      clock += dt;
      const blend = 1 - Math.exp(-dt * 2);
      for (const key of ["intensity", "motion", "density", "halloween"] as const)
        look[key] += (target[key] - look[key]) * blend;

      // The loudest deck's level and beat move the corn and the footsteps.
      let lane = 0;
      for (let k = 1; k < LANES; k++) if ((energy[k * 4] ?? 0) > (energy[lane * 4] ?? 0)) lane = k;
      const loud = Math.min(1, Math.sqrt(Math.max(0, energy[lane * 4] ?? 0)) * 1.7);
      level += (loud - level) * (1 - Math.exp(-dt * 10));
      low += (Math.min(1, energy[lane * 4 + 1] ?? 0) - low) * (1 - Math.exp(-dt * 14));
      const playing = loud > 0.025;
      const phase = playing ? (motion[lane * 4 + 3] ?? 0) : clock * 1.6;

      chooseSource(dt);
      scheduleScares();
      playScare();
      const style = sectionAt(source.song, source.time)?.style ?? "vocal";

      sprint *= Math.exp(-dt * 0.6);
      const pace = PACE[style] * (0.45 + look.motion * 0.55) * (reduced.matches ? 0.4 : 1);
      const goal = pace * effects.slow * (1 + sprint * 0.9);
      speed += (goal - speed) * (1 - Math.exp(-dt * (effects.slow < 1 ? 8 : 2)));
      travel += speed * dt;
      growCorn();

      // Walk the path at eye height, bobbing with each step on the beat.
      const stride = Math.min(1, speed / 2);
      const step = Math.abs(Math.sin(phase * Math.PI));
      placeOnPath(travel, Math.sin(phase * Math.PI) * 0.04 * stride, EYE + step * 0.05 * stride, camera.position);
      placeOnPath(travel + 4, 0, EYE - 0.12, bend);
      if (!gazeReady) {
        gaze.copy(bend);
        gazeReady = true;
      }
      const target3 = effects.gazeAt ?? bend;
      gaze.lerp(target3, 1 - Math.exp(-dt * (effects.gazeAt ? 10 : 4)));
      camera.lookAt(gaze);
      shake *= Math.exp(-dt * 3.5);
      if (shake > 0.002) {
        camera.position.x += (Math.random() - 0.5) * shake * 0.08;
        camera.position.y += (Math.random() - 0.5) * shake * 0.08;
        camera.rotateZ((Math.random() - 0.5) * shake * 0.04);
      }
      camera.fov += ((active?.struck ? 58 : 68) - camera.fov) * (1 - Math.exp(-dt * 6));
      camera.updateProjectionMatrix();

      sky.position.copy(camera.position);
      ground.position.set(Math.round(camera.position.x / CELL) * CELL, 0, Math.round(camera.position.z / CELL) * CELL);

      // The flashlight wavers in the hand, dims through breakdowns and stutters in build-ups.
      const intensity = look.intensity;
      let beam = (style === "break" ? 0.75 : 1) * (0.85 + level * 0.25);
      if (style === "build" && Math.sin(clock * 37) + Math.sin(clock * 61) > 1.75) beam *= 0.25;
      flashlight.intensity = 7 * intensity * beam * effects.light;
      flashlight.target.position.set(Math.sin(clock * 0.7) * 0.4, -0.6 + Math.sin(clock * 1.1) * 0.15, -6);
      lightning *= Math.exp(-dt * 2.5);
      const strike = lightning > 0.02 && Math.sin(clock * 50) > -0.2 ? lightning : 0;
      moon.intensity = (0.35 + strike * 4) * intensity;
      hemisphere.intensity = (0.6 + strike * 1.5) * intensity * (effects.light === 0 ? 0.25 : 1);
      skyMaterial.uniforms.time!.value = clock;
      skyMaterial.uniforms.flash!.value = strike;

      cornUniforms.time.value = clock;
      cornUniforms.gust.value = low * intensity;
      cornUniforms.rustle.value += (effects.rustle - cornUniforms.rustle.value) * (1 - Math.exp(-dt * 6));
      faceMaterial.color.setHex(0xff9a1a).multiplyScalar(2 + Math.sin(clock * 9) * 0.3 + level * 0.8);

      // Mist drifts slowly and wraps around the walker.
      mistSeeds.forEach((seed, i) => {
        seed.x += seed.speed * dt;
        const x = THREE.MathUtils.euclideanModulo(seed.x - camera.position.x + 15, 30) - 15 + camera.position.x;
        const z = THREE.MathUtils.euclideanModulo(seed.z - camera.position.z + 15, 30) - 15 + camera.position.z;
        mistPosition.setXYZ(i, x, seed.y + Math.sin(clock * 0.3 + i) * 0.1, z);
      });
      mistPosition.needsUpdate = true;
      mistMaterial.uniforms.strength!.value = style === "break" ? 1.6 : 1;

      flash *= Math.exp(-dt * 5);
      split *= Math.exp(-dt * 3);
      fright.uniforms.time!.value = clock;
      fright.uniforms.flash!.value = flash;
      fright.uniforms.split!.value = split;
      fright.uniforms.dark!.value = effects.dark;
      bloom.strength = 0.6 + intensity * 0.3;

      const next = planFor().find((s) => s.at > source.time);
      status = `${style}${source.key === "idle" ? " · demo song" : ""}${
        next ? ` · next: ${next.kind} in ${Math.max(0, next.at - source.time).toFixed(0)}s` : ""
      }`;

      composer.render(dt);
    },
    dispose() {
      composer.dispose();
      for (const item of disposables) item.dispose();
      for (const actor of actors.values()) disposeActor(actor);
      corn.dispose();
      pumpkins.dispose();
      faces.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
