import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { DEFAULT_VISUAL_LOOK, type VisualLook } from "../../../dj-monitor/src/visual-presets.js";
import { createMusicFollower } from "../music/follow.js";
import { sectionAt, type SongMap } from "../music/song-map.js";
import type { MusicLane, SceneEngine } from "../scenes.js";
import { buildCourse, COURSE_RATE, courseFrame, type Course } from "./rainbow-course.js";

const WIDTH = 16;
const COLUMNS = 28;
const RAIL_HEIGHT = 0.7;
/** Course samples drawn behind and ahead of the kart. */
const BEHIND = 30;
const AHEAD = 480;
const ROWS = BEHIND + AHEAD;
const POST_EVERY = 10;
const STAR_EVERY = 45;
const BOO_EVERY = 90;

const RAINBOW_GLSL = /* glsl */ `
vec3 hsv(float h, float s, float v) {
  vec3 k = clamp(abs(mod(h * 6. + vec3(0., 4., 2.), 6.) - 3.) - 1., 0., 1.);
  return v * mix(vec3(1.), k, s);
}
// Seven lanes, red on the left through violet on the right.
vec3 lane(float x) {
  float band = (floor(clamp(x, 0., .999) * 7.) + .5) / 7.;
  return hsv(band * .8, .86, 1.);
}`;

const NOISE_GLSL = /* glsl */ `
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float sum = 0., amp = .5;
  for (int i = 0; i < 5; i++) { sum += amp * noise(p); p *= 2.03; amp *= .5; }
  return sum;
}`;

type Frame = { point: THREE.Vector3; tangent: THREE.Vector3; up: THREE.Vector3; right: THREE.Vector3 };
const newFrame = (): Frame => ({
  point: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  up: new THREE.Vector3(),
  right: new THREE.Vector3(),
});

/** A deterministic 0–1 value per course sample, so decorations stay where they were placed. */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

function canvasTexture(size: number, paint: (context: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  paint(canvas.getContext("2d")!);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function starShape(outer: number, inner: number) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? inner : outer;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    if (i) shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  return shape;
}

function createBoo() {
  const boo = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xd8d4ff,
    emissiveIntensity: 0.25,
    roughness: 0.6,
    transparent: true,
  });
  const dark = new THREE.MeshBasicMaterial({ color: 0x120818, transparent: true });
  const red = new THREE.MeshBasicMaterial({ color: 0xff3a5c, transparent: true });
  boo.add(new THREE.Mesh(new THREE.SphereGeometry(1.4, 32, 24), white));
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), dark);
    eye.scale.set(0.7, 1.4, 0.4);
    eye.position.set(side * 0.42, 0.3, 1.3);
    boo.add(eye);
    const arm = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), white);
    arm.scale.set(0.6, 1, 0.6);
    arm.position.set(side * 1.25, -0.2, 0.5);
    boo.add(arm);
  }
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), dark);
  mouth.rotation.x = Math.PI;
  mouth.scale.set(1, 0.9, 0.3);
  mouth.position.set(0, -0.25, 1.28);
  boo.add(mouth);
  const tongue = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 8), red);
  tongue.scale.set(1, 0.6, 0.4);
  tongue.position.set(0, -0.62, 1.32);
  boo.add(tongue);
  return { group: boo, materials: [white, dark, red] };
}

/** A strip of `ROWS` cross-sections whose vertices are rewritten every frame. */
function stripGeometry(columns: number) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(ROWS * (columns + 1) * 3), 3).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array(ROWS * (columns + 1) * 2), 2).setUsage(THREE.DynamicDrawUsage),
  );
  const indices: number[] = [];
  for (let i = 0; i < ROWS - 1; i++)
    for (let j = 0; j < columns; j++) {
      const k = i * (columns + 1) + j,
        next = k + columns + 1;
      indices.push(k, next, k + 1, k + 1, next, next + 1);
    }
  geometry.setIndex(indices);
  return geometry;
}

/** Mario Kart's Rainbow Road, laid out by the song: its turns, climbs and dives follow the music. */
export async function createRainbowRoad(host: HTMLCanvasElement): Promise<SceneEngine> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.82;
  renderer.setClearColor(0x020108, 1);
  host.after(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(64, 1, 0.1, 6000);
  scene.add(new THREE.AmbientLight(0xb8b0ff, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-1, 2, 1.5);
  scene.add(sun);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(item: T) => (disposables.push(item), item);

  // Everything far away travels with the camera: the course can wander anywhere in space.
  const backdrop = new THREE.Group();
  scene.add(backdrop);
  const skyMaterial = keep(
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { time: { value: 0 }, spook: { value: 0 } },
      vertexShader: /* glsl */ `varying vec3 vDir;
        void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */ `uniform float time, spook; varying vec3 vDir;
        ${NOISE_GLSL}
        void main() {
          float n = fbm(vDir * 2.2 + vec3(0., 0., time * .004));
          float m = fbm(vDir * 4.5 - 3.1);
          vec3 base = mix(vec3(.004, .006, .025), vec3(.012, .004, .03), vDir.y * .5 + .5);
          vec3 cloudA = mix(vec3(.25, .08, .45), vec3(.35, .12, .08), spook);
          vec3 cloudB = mix(vec3(.05, .18, .42), vec3(.14, .04, .22), spook);
          vec3 color = base + cloudA * pow(n, 3.4) * .7 + cloudB * pow(m, 3.6) * .55;
          gl_FragColor = vec4(color, 1.);
        }`,
    }),
  );
  backdrop.add(new THREE.Mesh(keep(new THREE.SphereGeometry(4500, 48, 32)), skyMaterial));

  const starCount = 6000;
  const starPositions = new Float32Array(starCount * 3);
  const starAttributes = new Float32Array(starCount * 2);
  for (let i = 0; i < starCount; i++) {
    new THREE.Vector3()
      .randomDirection()
      .multiplyScalar(1800 + Math.random() * 1800)
      .toArray(starPositions, i * 3);
    starAttributes[i * 2] = 3 + Math.pow(Math.random(), 5) * 12;
    starAttributes[i * 2 + 1] = Math.random() * Math.PI * 2;
  }
  const starGeometry = keep(new THREE.BufferGeometry());
  starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  starGeometry.setAttribute("star", new THREE.BufferAttribute(starAttributes, 2));
  const starMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { time: { value: 0 }, pixelRatio: { value: 1 } },
      vertexShader: /* glsl */ `attribute vec2 star; uniform float time, pixelRatio; varying float vTwinkle;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.);
          vTwinkle = .45 + .2 * sin(time * (.6 + star.y * .4) + star.y * 7.);
          gl_PointSize = star.x * pixelRatio * (900. / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `varying float vTwinkle;
        void main() {
          vec2 c = gl_PointCoord - .5;
          float d = length(c);
          float cross = max(0., 1. - abs(c.x) * 14.) * max(0., 1. - abs(c.y) * 2.2) + max(0., 1. - abs(c.y) * 14.) * max(0., 1. - abs(c.x) * 2.2);
          float a = (smoothstep(.5, 0., d) * .6 + cross * .2) * vTwinkle;
          gl_FragColor = vec4(vec3(1., .96, .9) * a, a);
        }`,
    }),
  );
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.frustumCulled = false;
  backdrop.add(stars);

  const planetMaterial = keep(
    new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, light: { value: new THREE.Vector3(-1, 0.6, 0.8).normalize() } },
      vertexShader: /* glsl */ `varying vec3 vNormal, vLocal, vView;
        void main() {
          vLocal = normalize(position);
          vNormal = normalize(mat3(modelMatrix) * normal);
          vec4 world = modelMatrix * vec4(position, 1.);
          vView = normalize(cameraPosition - world.xyz);
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `uniform float time; uniform vec3 light; varying vec3 vNormal, vLocal, vView;
        ${NOISE_GLSL}
        void main() {
          float land = smoothstep(.52, .56, fbm(vLocal * 2.6));
          float ice = smoothstep(.8, .9, abs(vLocal.y));
          vec3 surface = mix(vec3(.03, .16, .48), mix(vec3(.12, .42, .14), vec3(.55, .48, .3), fbm(vLocal * 7.)), land);
          surface = mix(surface, vec3(.95), ice);
          float clouds = smoothstep(.55, .75, fbm(vLocal * 4. + vec3(time * .01, 0., 0.)));
          surface = mix(surface, vec3(1.), clouds * .8);
          float diffuse = clamp(dot(vNormal, light) * 1.1 + .08, 0., 1.);
          float rim = pow(1. - max(0., dot(vNormal, vView)), 3.);
          gl_FragColor = vec4(surface * diffuse + vec3(.3, .6, 1.) * rim * 1.4, 1.);
        }`,
    }),
  );
  const earth = new THREE.Mesh(keep(new THREE.SphereGeometry(420, 96, 64)), planetMaterial);
  earth.position.set(900, -420, 1300);
  backdrop.add(earth);
  const moon = new THREE.Mesh(
    keep(new THREE.SphereGeometry(90, 48, 32)),
    keep(new THREE.MeshStandardMaterial({ color: 0xb9b6c4, roughness: 0.95 })),
  );
  moon.position.set(-1300, 240, -900);
  backdrop.add(moon);

  // The road and everything on it live in the course's own space, placed by `placement`.
  const course3d = new THREE.Group();
  course3d.matrixAutoUpdate = false;
  scene.add(course3d);

  const roadMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      uniforms: {
        time: { value: 0 },
        glow: { value: 1 },
        energy: { value: 0.5 },
        head: { value: 0 },
        span: { value: 600 },
      },
      vertexShader: /* glsl */ `varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */ `uniform float time, glow, energy, head, span; varying vec2 vUv;
        ${RAINBOW_GLSL}
        void main() {
          float x = vUv.x, along = vUv.y;
          vec3 color = lane(x);
          float laneEdge = abs(fract(x * 7.) - .5);
          color *= .82 + .18 * smoothstep(.5, .42, laneEdge);
          float seam = smoothstep(.06, 0., abs(fract(along / 7.) - .5) - .44);
          float lines = smoothstep(.47, .5, laneEdge);
          // The shimmer sweeps faster and brighter as the music fills out.
          float shimmer = pow(.5 + .5 * sin(along * .08 - time), 10.) * (.15 + energy * .25);
          float edge = smoothstep(.035, 0., min(x, 1. - x));
          vec3 lit = color * (.45 + shimmer) * glow + vec3(1.) * (seam * .12 + lines * .04 + edge * .35);
          float alpha = (.72 + seam * .15 + edge * .2) * smoothstep(span, span * .7, along - head);
          gl_FragColor = vec4(lit, alpha);
        }`,
    }),
  );
  const roadGeometry = keep(stripGeometry(COLUMNS));
  const road = new THREE.Mesh(roadGeometry, roadMaterial);
  road.renderOrder = 2;

  const underglowMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { glow: { value: 1 }, head: { value: 0 }, span: { value: 600 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */ `uniform float glow, head, span; varying vec2 vUv;
        ${RAINBOW_GLSL}
        void main() {
          float fade = smoothstep(0., .25, vUv.x) * smoothstep(1., .75, vUv.x) * smoothstep(span, span * .7, vUv.y - head);
          gl_FragColor = vec4(lane(vUv.x) * fade * .07 * glow, 1.);
        }`,
    }),
  );
  const underglowGeometry = keep(stripGeometry(COLUMNS));
  const underglow = new THREE.Mesh(underglowGeometry, underglowMaterial);

  // Rails: a cross-shaped glowing strip on each side, visible from any angle.
  const railMaterial = keep(
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.95, 0.78, 0.36), side: THREE.DoubleSide }),
  );
  const rails = [-1, 1].flatMap((side) =>
    [0, 1].map((flat) => ({ geometry: keep(stripGeometry(1)), side, flat })),
  );
  const strips = [road, underglow, ...rails.map((rail) => new THREE.Mesh(rail.geometry, railMaterial))];
  for (const strip of strips) {
    // The strips move with the kart; never cull them against a stale bounding sphere.
    strip.frustumCulled = false;
    course3d.add(strip);
  }

  const postCount = (Math.ceil(ROWS / POST_EVERY) + 1) * 2;
  const posts = new THREE.InstancedMesh(
    keep(new THREE.CylinderGeometry(0.08, 0.08, RAIL_HEIGHT, 6)),
    keep(new THREE.MeshBasicMaterial({ color: 0xd9c27a })),
    postCount,
  );
  const bulbs = new THREE.InstancedMesh(
    keep(new THREE.SphereGeometry(0.28, 12, 10)),
    keep(new THREE.MeshBasicMaterial({ color: 0xffffff })),
    postCount,
  );
  const bulbColors = [0xff4060, 0xffb030, 0xfff060, 0x50ff80, 0x40c8ff, 0xb070ff].map((c) =>
    new THREE.Color(c).multiplyScalar(1.1),
  );
  for (let i = 0; i < postCount; i++) bulbs.setColorAt(i, bulbColors[0]!);
  posts.frustumCulled = bulbs.frustumCulled = false;
  course3d.add(posts, bulbs);

  const dashTexture = keep(
    canvasTexture(256, (c) => {
      c.fillStyle = "#ff7a00";
      c.fillRect(0, 0, 256, 256);
      c.fillStyle = "#ffe14a";
      for (let y = -64; y < 256; y += 128) {
        c.beginPath();
        c.moveTo(20, y + 110);
        c.lineTo(128, y + 10);
        c.lineTo(236, y + 110);
        c.lineTo(236, y + 160);
        c.lineTo(128, y + 60);
        c.lineTo(20, y + 160);
        c.closePath();
        c.fill();
      }
    }),
  );
  dashTexture.wrapT = THREE.RepeatWrapping;
  dashTexture.repeat.set(1, 2);
  const dashMaterial = keep(
    new THREE.MeshBasicMaterial({ map: dashTexture, color: new THREE.Color(1.2, 1.2, 1.2), side: THREE.DoubleSide }),
  );
  const dashGeometry = keep(new THREE.PlaneGeometry(3.6, 7));
  dashGeometry.rotateX(-Math.PI / 2);
  const dashes = Array.from({ length: 9 }, () => course3d.add(new THREE.Mesh(dashGeometry, dashMaterial)).children.at(-1)!);

  const questionTexture = keep(
    canvasTexture(128, (c) => {
      c.clearRect(0, 0, 128, 128);
      c.font = "900 104px Arial Black, Arial, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.lineWidth = 10;
      c.strokeStyle = "#3a2a00";
      c.strokeText("?", 64, 70);
      c.fillStyle = "#fff6c8";
      c.fillText("?", 64, 70);
    }),
  );
  const boxMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      uniforms: { time: { value: 0 }, mark: { value: questionTexture } },
      vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vNormal, vView;
        void main() {
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `uniform float time; uniform sampler2D mark; varying vec2 vUv; varying vec3 vNormal, vView;
        ${RAINBOW_GLSL}
        void main() {
          float facing = dot(vNormal, vView);
          vec3 color = hsv(fract(facing * .6 + vUv.x * .3 + vUv.y * .2 + time * .25), .65, 1.1);
          vec2 border = min(vUv, 1. - vUv);
          float frame = smoothstep(.09, .05, min(border.x, border.y));
          vec4 q = texture2D(mark, vUv);
          vec3 lit = mix(color * .8, vec3(1.1), frame * .6);
          lit = mix(lit, q.rgb * 1.3, q.a);
          gl_FragColor = vec4(lit, .55 + frame * .35 + q.a * .4);
        }`,
    }),
  );
  const boxGeometry = keep(new THREE.BoxGeometry(2.2, 2.2, 2.2));
  const boxes = Array.from({ length: 24 }, () => course3d.add(new THREE.Mesh(boxGeometry, boxMaterial)).children.at(-1)!);

  // Smashing through an item box: rainbow shards and a flash, streaming past the camera.
  const SHARDS = 120;
  const shardMesh = new THREE.InstancedMesh(
    keep(new THREE.TetrahedronGeometry(0.26)),
    keep(new THREE.MeshBasicMaterial({ color: 0xffffff })),
    SHARDS,
  );
  shardMesh.frustumCulled = false;
  course3d.add(shardMesh);
  const shards = Array.from({ length: SHARDS }, () => ({
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    gravity: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    age: 0,
    life: 0,
  }));
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < SHARDS; i++) {
    shardMesh.setMatrixAt(i, hidden);
    shardMesh.setColorAt(i, new THREE.Color(1, 1, 1));
  }
  let nextShard = 0;
  const flashTexture = keep(
    canvasTexture(128, (c) => {
      const gradient = c.createRadialGradient(64, 64, 0, 64, 64, 64);
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(0.25, "rgba(255,240,200,0.7)");
      gradient.addColorStop(1, "rgba(255,200,255,0)");
      c.fillStyle = gradient;
      c.fillRect(0, 0, 128, 128);
    }),
  );
  const flashes = Array.from({ length: 3 }, () => {
    const sprite = new THREE.Sprite(
      keep(
        new THREE.SpriteMaterial({
          map: flashTexture,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      ),
    );
    sprite.visible = false;
    course3d.add(sprite);
    return { sprite, age: Infinity };
  });
  let nextFlash = 0;
  let pop = 0;

  const goldMaterial = keep(
    new THREE.MeshStandardMaterial({
      color: 0xffd23a,
      emissive: 0xffb000,
      emissiveIntensity: 0.7,
      roughness: 0.3,
      metalness: 0.4,
    }),
  );
  const goldGeometry = keep(
    new THREE.ExtrudeGeometry(starShape(1.6, 0.7), {
      depth: 0.5,
      bevelEnabled: true,
      bevelSize: 0.15,
      bevelThickness: 0.15,
      bevelSegments: 2,
    }),
  );
  goldGeometry.center();
  const goldStars = Array.from(
    { length: Math.ceil(ROWS / STAR_EVERY) + 1 },
    () => course3d.add(new THREE.Mesh(goldGeometry, goldMaterial)).children.at(-1)!,
  );

  const booMaterials: THREE.Material[] = [];
  const boos = Array.from({ length: Math.ceil(ROWS / BOO_EVERY) + 1 }, () => {
    const { group, materials } = createBoo();
    for (const material of materials) booMaterials.push(keep(material));
    group.traverse((child) => child instanceof THREE.Mesh && keep(child.geometry));
    group.scale.setScalar(1.4);
    course3d.add(group);
    return group;
  });

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.4, 0.35, 0.88);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  let target: VisualLook = { ...DEFAULT_VISUAL_LOOK, halloween: 0.3 };
  const look = { ...target };
  let width = 0,
    height = 0,
    pixelRatio = 0,
    previous: number | undefined;

  // The music the road follows, and the course laid out for it.
  const follower = createMusicFollower();
  const idle = follower.idle;
  let lanes: MusicLane[] = [];
  let source = { key: "idle", song: idle, time: 0 };
  let course: Course = buildCourse(idle, 1);
  let courseKey = "idle:1";
  let speedScale = 1;
  let pendingScale = 1;
  let scaleChangedAt = 0;
  let placed = false;
  const placement = new THREE.Matrix4();
  const here = newFrame(),
    ahead = newFrame(),
    scratch = newFrame();
  const eye = new THREE.Vector3(),
    focus = new THREE.Vector3(),
    tmp = new THREE.Vector3(),
    back = new THREE.Vector3();
  const matrix = new THREE.Matrix4(),
    from = new THREE.Matrix4(),
    to = new THREE.Matrix4();

  const frameWorld = (index: number, out: Frame) => {
    courseFrame(course, index, out);
    out.point.applyMatrix4(placement);
    out.tangent.transformDirection(placement);
    out.up.transformDirection(placement);
    out.right.transformDirection(placement);
    return out;
  };

  // Each row of boxes has one middle box the kart drives through.
  const laneOffset = (k: number) => (k - 1.5) * 3.4;
  const hitLane = (row: number) => (hash(row + 11) > 0.5 ? 2 : 1);
  const rowShown = (row: number) => hash(row) <= 0.3 + look.density * 0.7;
  const broken = new Set<number>();
  const inverse = new THREE.Matrix4();
  const cameraLocal = new THREE.Vector3();
  const boxLocal = new THREE.Vector3();
  let steer = 0;
  let aim = 0;

  const smash = (at: THREE.Vector3, frame: Frame, speed: number) => {
    for (let n = 0; n < 34; n++) {
      const shard = shards[nextShard]!;
      shardMesh.setColorAt(
        nextShard,
        new THREE.Color().setHSL(Math.random(), 1, n % 5 === 0 ? 0.9 : 0.55),
      );
      nextShard = (nextShard + 1) % SHARDS;
      const burst = new THREE.Vector3().randomDirection();
      shard.position.copy(at).addScaledVector(burst, 0.6);
      // Shards keep most of the kart's speed, so they fly past the camera rather than vanish.
      shard.velocity
        .copy(frame.tangent)
        .multiplyScalar(speed * 0.86)
        .addScaledVector(burst, 6 + Math.random() * 6)
        .addScaledVector(frame.up, 3);
      shard.gravity.copy(frame.up).multiplyScalar(-14);
      shard.spin.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(18);
      shard.age = 0;
      shard.life = 0.9 + Math.random() * 0.6;
    }
    if (shardMesh.instanceColor) shardMesh.instanceColor.needsUpdate = true;
    const flash = flashes[nextFlash]!;
    nextFlash = (nextFlash + 1) % flashes.length;
    flash.sprite.position.copy(at);
    flash.age = 0;
    pop = 1;
  };

  const shardRotation = new THREE.Euler();
  const shardQuaternion = new THREE.Quaternion();
  const shardScale = new THREE.Vector3();
  const animateDebris = (dt: number) => {
    shards.forEach((shard, i) => {
      if (shard.age >= shard.life) return;
      shard.age += dt;
      if (shard.age >= shard.life) return shardMesh.setMatrixAt(i, hidden);
      shard.velocity.addScaledVector(shard.gravity, dt);
      shard.position.addScaledVector(shard.velocity, dt);
      shardRotation.set(shard.spin.x * shard.age, shard.spin.y * shard.age, shard.spin.z * shard.age);
      shardScale.setScalar(1 - Math.pow(shard.age / shard.life, 2));
      matrix.compose(shard.position, shardQuaternion.setFromEuler(shardRotation), shardScale);
      shardMesh.setMatrixAt(i, matrix);
    });
    shardMesh.instanceMatrix.needsUpdate = true;
    for (const flash of flashes) {
      flash.age += dt;
      const t = flash.age / 0.35;
      flash.sprite.visible = t < 1;
      if (t < 1) {
        flash.sprite.scale.setScalar(1.5 + 9 * Math.sqrt(t));
        (flash.sprite.material as THREE.SpriteMaterial).opacity = 1 - t;
      }
    }
    pop = Math.max(0, pop - dt * 3);
  };

  /** Steer towards the next box, and smash it just before the camera reaches it. */
  const driveThroughBoxes = (head: number, speed: number, dt: number) => {
    cameraLocal.copy(camera.position).applyMatrix4(inverse.copy(placement).invert());
    let steerTarget = 0,
      aimTarget = 0;
    for (const row of course.items) {
      if (row < head - 90 || row > head + 120 || !rowShown(row) || broken.has(row)) continue;
      courseFrame(course, row, scratch);
      const offset = laneOffset(hitLane(row));
      boxLocal.copy(scratch.point).addScaledVector(scratch.right, offset).addScaledVector(scratch.up, 1.9);
      const ahead = tmp.copy(boxLocal).sub(cameraLocal).dot(scratch.tangent);
      if (ahead < 2.5 && ahead > -15) {
        broken.add(row);
        smash(boxLocal, scratch, speed);
      } else if (ahead >= 2.5 && ahead < 55 && !aimTarget) {
        aimTarget = THREE.MathUtils.smoothstep(ahead, 55, 22);
        steerTarget = offset * aimTarget;
      }
    }
    // Ease out of the way afterwards just as gently as into it.
    steer += (steerTarget - steer) * (1 - Math.exp(-dt * 3));
    aim += (aimTarget - aim) * (1 - Math.exp(-dt * 3));
    animateDebris(dt);
  };

  /** Lay out a new course, placed so it continues seamlessly from where the kart is now. */
  const relayout = () => {
    broken.clear();
    course = buildCourse(source.song, speedScale);
    courseKey = `${source.key}:${speedScale}`;
    const local = courseFrame(course, source.time * COURSE_RATE, scratch);
    from.makeBasis(local.right, local.up, local.tangent).setPosition(local.point).invert();
    to.makeBasis(here.right, here.up, here.tangent).setPosition(here.point);
    placement.multiplyMatrices(to, from);
  };

  /** Pose a decoration on the course, facing back down the road towards the kart. */
  const orient = (object: THREE.Object3D, index: number, offset: number, lift: number) => {
    courseFrame(course, index, scratch);
    object.position.copy(scratch.point).addScaledVector(scratch.right, offset).addScaledVector(scratch.up, lift);
    matrix.makeBasis(scratch.right, scratch.up, back.copy(scratch.tangent).negate());
    object.quaternion.setFromRotationMatrix(matrix);
  };

  /** Rewrite the visible stretch of road, rails and decorations around the kart. */
  const layRoad = (first: number) => {
    const roadPosition = roadGeometry.attributes.position!.array as Float32Array;
    const roadUv = roadGeometry.attributes.uv!.array as Float32Array;
    const glowPosition = underglowGeometry.attributes.position!.array as Float32Array;
    const glowUv = underglowGeometry.attributes.uv!.array as Float32Array;
    for (let r = 0; r < ROWS; r++) {
      const index = Math.min(course.count - 1, Math.max(0, first + r));
      courseFrame(course, index, scratch);
      const along = course.distance[index]!;
      for (let j = 0; j <= COLUMNS; j++) {
        const x = j / COLUMNS;
        const k = r * (COLUMNS + 1) + j;
        tmp.copy(scratch.point).addScaledVector(scratch.right, (x - 0.5) * WIDTH).toArray(roadPosition, k * 3);
        tmp
          .copy(scratch.point)
          .addScaledVector(scratch.right, (x - 0.5) * WIDTH * 1.6)
          .addScaledVector(scratch.up, -1.2)
          .toArray(glowPosition, k * 3);
        roadUv[k * 2] = glowUv[k * 2] = x;
        roadUv[k * 2 + 1] = glowUv[k * 2 + 1] = along;
      }
      for (const rail of rails) {
        const position = rail.geometry.attributes.position!.array as Float32Array;
        tmp
          .copy(scratch.point)
          .addScaledVector(scratch.right, rail.side * (WIDTH / 2 + 0.25))
          .addScaledVector(scratch.up, RAIL_HEIGHT);
        const spread = rail.flat ? scratch.right : scratch.up;
        for (let j = 0; j < 2; j++) {
          const k = (r * 2 + j) * 3;
          const offset = (j - 0.5) * 0.26;
          position[k] = tmp.x + spread.x * offset;
          position[k + 1] = tmp.y + spread.y * offset;
          position[k + 2] = tmp.z + spread.z * offset;
        }
      }
    }
    for (const geometry of [roadGeometry, underglowGeometry, ...rails.map((rail) => rail.geometry)]) {
      geometry.attributes.position!.needsUpdate = true;
      geometry.attributes.uv!.needsUpdate = true;
    }

    const last = Math.min(course.count, first + ROWS);
    const firstAt = (every: number) => Math.ceil(Math.max(0, first) / every) * every;

    let n = 0;
    for (let g = firstAt(POST_EVERY); g < last; g += POST_EVERY)
      for (const side of [-1, 1]) {
        if (n >= postCount) break;
        courseFrame(course, g, scratch);
        matrix.makeBasis(scratch.right, scratch.up, back.copy(scratch.tangent).negate());
        tmp.copy(scratch.point).addScaledVector(scratch.right, side * (WIDTH / 2 + 0.25));
        matrix.setPosition(tmp.addScaledVector(scratch.up, RAIL_HEIGHT / 2));
        posts.setMatrixAt(n, matrix);
        matrix.setPosition(tmp.addScaledVector(scratch.up, RAIL_HEIGHT / 2 + 0.1));
        bulbs.setMatrixAt(n, matrix);
        bulbs.setColorAt(n, bulbColors[(g / POST_EVERY) % bulbColors.length]!);
        n++;
      }
    posts.count = bulbs.count = n;
    posts.instanceMatrix.needsUpdate = bulbs.instanceMatrix.needsUpdate = true;
    if (bulbs.instanceColor) bulbs.instanceColor.needsUpdate = true;

    // Item boxes: a row of four across the road.
    let used = 0;
    for (const index of course.items) {
      if (index < first || index >= last || hash(index) > 0.3 + look.density * 0.7) continue;
      for (let k = 0; k < 4 && used < boxes.length; k++)
        if (!(k === hitLane(index) && broken.has(index))) orient(boxes[used++]!, index, laneOffset(k), 1.9);
    }
    boxes.forEach((box, i) => (box.visible = i < used));

    used = 0;
    for (const index of course.dashes)
      if (index >= first && index < last && used < dashes.length) orient(dashes[used++]!, index, 0, 0.06);
    dashes.forEach((dash, i) => (dash.visible = i < used));

    used = 0;
    for (let g = firstAt(STAR_EVERY); g < last && used < goldStars.length; g += STAR_EVERY) {
      const star = goldStars[used++]!;
      const side = hash(g) > 0.5 ? 1 : -1;
      orient(star, g, side * (WIDTH / 2 + 8 + hash(g + 1) * 18), 4 + hash(g + 2) * 14);
      star.rotateY(previous ?? 0);
      star.visible = hash(g + 3) < 0.3 + look.density * 0.7;
    }
    goldStars.forEach((star, i) => i >= used && (star.visible = false));

    used = 0;
    const spook = THREE.MathUtils.smoothstep(look.halloween, 0.05, 0.6);
    for (let g = firstAt(BOO_EVERY); g < last && used < boos.length; g += BOO_EVERY) {
      const boo = boos[used++]!;
      const side = hash(g + 5) > 0.5 ? 1 : -1;
      orient(boo, g, side * (WIDTH / 2 + 4 + hash(g + 6) * 8), 3 + hash(g + 7) * 5);
      boo.rotateY(-side * 0.5);
      boo.position.addScaledVector(scratch.up, Math.sin((previous ?? 0) * 1.3 + g) * 0.6);
      boo.visible = spook > 0.01;
    }
    boos.forEach((boo, i) => i >= used && (boo.visible = false));
    for (const material of booMaterials) material.opacity = spook;

    for (const box of boxes) box.rotateY((previous ?? 0) * 1.4);
  };

  const energyAt = (song: SongMap, time: number) => {
    let bar = 0;
    while (bar < song.bars.length - 1 && song.bars[bar + 1]! <= time) bar++;
    return song.energy[bar] ?? 0.5;
  };

  let status = "";
  let shimmerPhase = 0;

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
        starMaterial.uniforms.pixelRatio!.value = ratio;
      }
      const dt = previous === undefined ? 0 : Math.min(0.05, Math.max(0, time - previous));
      previous = time;
      const blend = 1 - Math.exp(-dt * 3);
      for (const key of ["intensity", "motion", "density", "halloween"] as const)
        look[key] += (target[key] - look[key]) * blend;

      // Motion sets the speed; the course is re-laid once the slider settles.
      const wanted = Math.round((0.4 + target.motion * 0.6) * 10) / 10;
      if (wanted !== pendingScale) {
        pendingScale = wanted;
        scaleChangedAt = time;
      }
      if (pendingScale !== speedScale && time - scaleChangedAt > 0.4) speedScale = pendingScale;
      source = follower.update(lanes, time, dt);
      if (`${source.key}:${speedScale}` !== courseKey) relayout();
      course3d.matrix.copy(placement);
      course3d.matrixWorldNeedsUpdate = true;

      const index = source.time * COURSE_RATE;
      frameWorld(index, here);
      const head = Math.min(course.count - 1, Math.floor(index));
      const headDistance = course.distance[head]!;
      let lookIndex = head;
      while (lookIndex < course.count - 1 && course.distance[lookIndex]! - headDistance < 24) lookIndex++;
      // Interpolate between samples so the gaze glides instead of stepping.
      const before = course.distance[Math.max(0, lookIndex - 1)]!,
        after = course.distance[lookIndex]!;
      const goal = course.distance[head]! + (index - head) * (course.distance[Math.min(course.count - 1, head + 1)]! - course.distance[head]!) + 24;
      frameWorld(lookIndex - 1 + THREE.MathUtils.clamp((goal - before) / Math.max(1e-3, after - before), 0, 1), ahead);

      const style = sectionAt(source.song, source.time)?.style ?? "vocal";
      const speed = (course.distance[Math.min(course.count - 1, head + 1)]! - headDistance) * COURSE_RATE;
      driveThroughBoxes(head, speed, dt);
      // Breakdowns lift the camera away from the road, like floating; a box ahead pulls it down to meet it.
      eye
        .copy(here.point)
        .addScaledVector(here.up, (style === "break" ? 5 : 3.4) - aim * 1.3)
        .addScaledVector(here.right, steer);
      if (!placed || camera.position.distanceTo(eye) > 40) {
        camera.position.copy(eye);
        camera.up.copy(here.up);
        placed = true;
      } else {
        camera.position.lerp(eye, 1 - Math.exp(-dt * 8));
        // Following the road's up vector makes swirls and banking roll the whole screen.
        camera.up.lerp(here.up, 1 - Math.exp(-dt * 5)).normalize();
      }
      camera.lookAt(focus.copy(ahead.point).addScaledVector(ahead.up, 1.6).addScaledVector(ahead.right, steer * 0.6));
      backdrop.position.copy(camera.position);
      layRoad(head - BEHIND);

      const energy = Math.min(1, energyAt(source.song, source.time));
      const glow = (0.75 + look.intensity * 0.25) * (style === "drop" ? 1.12 : style === "break" ? 0.85 : 1);
      const span = course.distance[Math.min(course.count - 1, head + AHEAD - 1)]! - headDistance;
      shimmerPhase += dt * (2 + energy * 3);
      roadMaterial.uniforms.time!.value = shimmerPhase;
      roadMaterial.uniforms.glow!.value = glow;
      roadMaterial.uniforms.energy!.value = energy;
      roadMaterial.uniforms.head!.value = headDistance;
      roadMaterial.uniforms.span!.value = span;
      underglowMaterial.uniforms.glow!.value = glow;
      underglowMaterial.uniforms.head!.value = headDistance;
      underglowMaterial.uniforms.span!.value = span;
      skyMaterial.uniforms.time!.value = time;
      skyMaterial.uniforms.spook!.value = look.halloween;
      starMaterial.uniforms.time!.value = time;
      planetMaterial.uniforms.time!.value = time;
      boxMaterial.uniforms.time!.value = time;
      dashTexture.offset.y = -time * 1.6;
      earth.rotation.y = time * 0.01;
      bloom.strength = 0.15 + look.intensity * 0.25 + pop * 0.35;

      const next = source.song.sections.find((s) => s.start > source.time);
      const swirlSoon = source.song.swirls.some((s) => s > source.time && s - source.time < 4);
      status =
        (source.key === "idle" ? "Demo course (no song playing)" : "Following the loudest deck") +
        ` · ${style.toUpperCase()}` +
        (next ? ` · ${next.style} in ${Math.ceil(next.start - source.time)}s` : "") +
        (swirlSoon ? " · swirl!" : "");

      composer.render(dt);
    },
    dispose() {
      composer.dispose();
      for (const item of disposables) item.dispose();
      posts.dispose();
      bulbs.dispose();
      shardMesh.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
