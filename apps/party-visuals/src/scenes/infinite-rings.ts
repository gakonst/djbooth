import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { DEFAULT_VISUAL_LOOK, type VisualLook } from "../../../dj-monitor/src/visual-presets.js";
import type { MusicLane, SceneEngine } from "../scenes.js";
import { beatIn, buildSongMap, melody, peakIn, type SongMap } from "./song-map.js";

const LANES = 3;
const RINGS = 34;
// Wide gaps keep every ring readable as it swells past the lens.
const SPACING = 2.6;
const DEPTH = RINGS * SPACING;
const RADIUS = 3;
const DOTS_PER_RING = 14;
const LOOK_AHEAD = 9;

// The song's mood picks the palette: calm, bass-heavy, vocal/melodic, then bright and airy.
const MOODS = [
  [0x2a3cff, 0x7a4dff, 0x22d3c5],
  [0xff2d55, 0xff7a1a, 0xff3d9a],
  [0xff3d9a, 0xb44dff, 0xff8fc8],
  [0x3de0ff, 0x8cffd9, 0xdde8ff],
].map((mood) => mood.map((hex) => new THREE.Color(hex)));

/** The tunnel's centre line at distance s: two slow, out-of-step sweeps make it swirl. */
function center(s: number, out: THREE.Vector2) {
  return out.set(
    Math.sin(s * 0.045) * 6 + Math.sin(s * 0.11) * 1.5,
    Math.cos(s * 0.037) * 4.5 + Math.sin(s * 0.09 + 1.3) * 1.2,
  );
}

function paletteAt(palette: THREE.Color[], position: number, out: THREE.Color) {
  const wrapped = ((position % palette.length) + palette.length) % palette.length;
  const i = Math.floor(wrapped);
  return out.lerpColors(palette[i]!, palette[(i + 1) % palette.length]!, wrapped - i);
}

const STARS = 1400;
// The tunnel holds the next twelve beats: hits appear far away and reach the lens as they sound.
const AHEAD_BEATS = 12;
// Where "now" sits: the nearest ring that is still fully visible.
const NOW_DEPTH = 3;
// Faces are drawn on a square in units of the hole radius; this is its half-width.
const FACE_EXTENT = 3.1;

export type TunnelShape = "rings" | "vinyl" | "eyes";

const FACE_VERTEX = /* glsl */ `
attribute vec3 aColor, aAccent;
attribute vec4 aParams;
attribute vec2 aWave;
attribute vec4 aHits;
varying vec2 vPos, vWave;
varying vec3 vColor, vAccent;
varying vec4 vParams, vHits;
void main() {
  vHits = aHits;
  vPos = position.xy;
  vColor = aColor;
  vAccent = aAccent;
  vParams = aParams;
  vWave = aWave;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.);
}`;

// Params: x fade, y spin, z hole (pupil) radius, w eyelid opening. Wave: x amplitude, y seed.
// Hits at this ring's moment in the song: x kick, y snare, z hat, w beat (1) or bar start (2).
const VINYL_FRAGMENT = /* glsl */ `
varying vec2 vPos, vWave;
varying vec3 vColor, vAccent;
varying vec4 vParams, vHits;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float fade = vParams.x, spin = vParams.y, hole = vParams.z;
  float r = length(vPos);
  if (r < hole || r > 2.) discard;
  float a = atan(vPos.y, vPos.x);
  float turned = a - spin;
  vec3 color;
  if (r < 1.3) {
    // The label: two-tone so the spin reads, with a thin printed ring.
    // Kicks light the label; a bar start flips its two tones.
    float flip = step(1.5, vHits.w);
    color = mix(vColor, vAccent, abs(step(0., sin(turned)) * .65 - flip * .65)) * (1. + vHits.x * .6);
    color += vAccent * smoothstep(.025, 0., abs(r - 1.14)) * (.7 + vHits.x * .4);
    color *= .7 + .3 * smoothstep(1.3, 1.22, r);
  } else {
    float groove = .5 + .5 * sin(r * 260.);
    float gap = smoothstep(.035, 0., abs(fract((r - 1.3) / .68 * 5.) - .5) - .46);
    // The sheen stays put while the record turns beneath it.
    float sheen = pow(abs(cos(a - .8)), 24.) * .55 + pow(abs(cos(a + .7)), 40.) * .3;
    float wave = vWave.x * (.5 + .5 * sin(turned * 5. + r * 22. + vWave.y));
    color = vec3(.03, .02, .04) + vec3(.9, .85, 1.) * sheen * (.22 + .18 * groove) * (1. - gap * .6);
    color += vAccent * wave * smoothstep(.35, 1., groove) * .8;
    // Snares flash the grooves; hats scatter glints across them.
    color += mix(vAccent, vec3(1.), .25) * vHits.y * smoothstep(.2, 1., groove) * (1. - gap) * .4;
    float glint = step(.985, hash(floor(vec2(turned * 40., r * 60.))));
    color += vec3(1., .95, 1.) * glint * vHits.z * .7;
    color += vColor * smoothstep(.035, 0., abs(r - 1.97)) * (.9 + vHits.w * .4);
  }
  float alpha = .84 * smoothstep(hole, hole + .02, r) * smoothstep(2., 1.985, r);
  gl_FragColor = vec4(color * fade, alpha * fade);
}`;

const EYE_FRAGMENT = /* glsl */ `
uniform float halloween;
varying vec2 vPos, vWave;
varying vec3 vColor, vAccent;
varying vec4 vParams, vHits;
void main() {
  float fade = vParams.x, spin = vParams.y, pupil = vParams.z, open = vParams.w;
  vec2 p = vPos;
  float r = length(p);
  float width = 3.;
  float lid = 1.95 * open * pow(max(0., 1. - p.x * p.x / (width * width)), .9);
  float edge = smoothstep(.09, 0., abs(abs(p.y) - lid)) * step(abs(p.x), width);
  float inside = smoothstep(lid, lid - .04, abs(p.y));
  if (r < pupil || (inside <= 0. && edge <= 0.)) discard;
  float a = atan(p.y, p.x);
  float irisR = 1.85;
  vec3 color;
  if (r < irisR) {
    // Iris fibres drift slowly, with a glowing rim around the pupil we fly into.
    float streak = .5 + .5 * sin(a * 38. + sin(a * 7. + spin) * 2.);
    float fibre = .5 + .5 * sin(a * 90. + r * 6. + vWave.y);
    color = mix(vColor, vAccent, smoothstep(pupil, irisR, r) * .8 + streak * .2);
    color *= .55 + .45 * streak * fibre + vWave.x * .3;
    // Snares flare the iris outward from the pupil.
    color += mix(vAccent, vec3(1.), .2) * vHits.y * streak * smoothstep(irisR, pupil, r) * .5;
    color += vAccent * smoothstep(.14, 0., r - pupil) * (1.3 + vHits.x * .6);
    color *= mix(.35, 1., smoothstep(irisR, irisR - .25, r));
  } else {
    vec3 sclera = mix(vec3(.6, .58, .68), vColor, .15);
    float veins = smoothstep(.8, 1., sin(a * 13. + sin(r * 5. + a * 3.) * 1.5)) * smoothstep(irisR + .2, width, r);
    color = mix(sclera, vec3(.8, .05, .08), veins * halloween * .85);
    color *= .5 + .5 * smoothstep(lid, lid * .35, abs(p.y));
  }
  // Hats glint along the lids; bar starts make the whole outline blaze.
  float glint = pow(.5 + .5 * sin(p.x * 9. + spin * 6.), 12.) * vHits.z;
  color = mix(color, vColor * (1.6 + vHits.w * .3) + glint * .5, edge);
  float alpha = max(inside * .86, edge) * smoothstep(pupil, pupil + .03, r);
  gl_FragColor = vec4(color * fade, alpha * fade);
}`;
const SKY_STARS = 2500;

/** Fly forever down a swirling tunnel of rings, records or eyes through space; each beat swells the glide. */
export async function createInfiniteRings(
  host: HTMLCanvasElement,
  shape: TunnelShape = "rings",
): Promise<SceneEngine> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  renderer.setClearColor(0x030008, 1);
  host.after(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 300);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(item: T) => (disposables.push(item), item);

  const additive = () =>
    keep(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );

  // Brightness lives in each instance color, so additive black means invisible.
  const rings = new THREE.InstancedMesh(
    keep(new THREE.TorusGeometry(1, 0.03, 10, 180)),
    additive(),
    RINGS,
  );
  const dots = new THREE.InstancedMesh(
    keep(new THREE.CircleGeometry(1, 24)),
    additive(),
    RINGS * DOTS_PER_RING,
  );
  for (const mesh of [rings, dots]) {
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.setColorAt(0, new THREE.Color());
    scene.add(mesh);
  }

  // Vinyl and eye faces: one shaded square per ring, drawn far to near so they layer correctly.
  const faceGeometry = keep(new THREE.PlaneGeometry(FACE_EXTENT * 2, FACE_EXTENT * 2));
  const faceAttributes = {
    aColor: new THREE.InstancedBufferAttribute(new Float32Array(RINGS * 3), 3),
    aAccent: new THREE.InstancedBufferAttribute(new Float32Array(RINGS * 3), 3),
    aParams: new THREE.InstancedBufferAttribute(new Float32Array(RINGS * 4), 4),
    aWave: new THREE.InstancedBufferAttribute(new Float32Array(RINGS * 2), 2),
    aHits: new THREE.InstancedBufferAttribute(new Float32Array(RINGS * 4), 4),
  };
  for (const [name, attribute] of Object.entries(faceAttributes)) {
    attribute.setUsage(THREE.DynamicDrawUsage);
    faceGeometry.setAttribute(name, attribute);
  }
  const faceMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { halloween: { value: 1 } },
      vertexShader: FACE_VERTEX,
      fragmentShader: shape === "eyes" ? EYE_FRAGMENT : VINYL_FRAGMENT,
    }),
  );
  const faces = new THREE.InstancedMesh(faceGeometry, faceMaterial, RINGS);
  faces.frustumCulled = false;
  faces.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  faces.visible = shape !== "rings";
  rings.visible = dots.visible = shape === "rings";
  scene.add(faces);
  const depths = new Float32Array(RINGS);
  const order = Array.from({ length: RINGS }, (_, i) => i);
  const slots = new Int32Array(RINGS);

  // A soft glow at the far end, so the hole always has somewhere to lead.
  const coreMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { color: { value: new THREE.Color() }, strength: { value: 0 } },
      vertexShader: /* glsl */ `varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
      fragmentShader: /* glsl */ `uniform vec3 color; uniform float strength; varying vec2 vUv;
        void main() {
          float d = length(vUv - .5) * 2.;
          gl_FragColor = vec4(color * strength * pow(max(0., 1. - d), 3.), 1.);
        }`,
    }),
  );
  const core = new THREE.Mesh(keep(new THREE.PlaneGeometry(1, 1)), coreMaterial);
  core.scale.setScalar(DEPTH * 0.5);
  scene.add(core);

  // Stars: a distant sky that only turns with the camera, and nearer stars drifting past the rings.
  const starMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { time: { value: 0 }, pixelRatio: { value: 1 }, glow: { value: 1 } },
      vertexShader: /* glsl */ `attribute vec3 star; uniform float time, pixelRatio; varying float vLight;
        void main() {
          vec4 view = modelViewMatrix * vec4(position, 1.);
          // star.x size, star.y twinkle phase, star.z fade.
          vLight = star.z * (.65 + .35 * sin(time * (1.3 + fract(star.y) * 2.) + star.y));
          gl_PointSize = star.x * pixelRatio * min(3., 60. / -view.z);
          gl_Position = projectionMatrix * view;
        }`,
      fragmentShader: /* glsl */ `uniform float glow; varying float vLight;
        void main() {
          float d = length(gl_PointCoord - .5) * 2.;
          float a = pow(max(0., 1. - d), 2.2) * vLight * glow;
          gl_FragColor = vec4(vec3(1., .9, .97) * a, 1.);
        }`,
    }),
  );
  const starField = (count: number) => {
    const geometry = keep(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute("star", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const points = new THREE.Points(geometry, starMaterial);
    points.frustumCulled = false;
    scene.add(points);
    return geometry;
  };
  const sky = starField(SKY_STARS);
  const skyPosition = sky.getAttribute("position") as THREE.BufferAttribute;
  const skyStar = sky.getAttribute("star") as THREE.BufferAttribute;
  const direction = new THREE.Vector3();
  for (let i = 0; i < SKY_STARS; i++) {
    direction.randomDirection().multiplyScalar(220);
    skyPosition.setXYZ(i, direction.x, direction.y, direction.z);
    skyStar.setXYZ(i, 8 + Math.pow(Math.random(), 5) * 40, Math.random() * 40, 0.5 + Math.random() * 0.5);
  }
  const drift = starField(STARS);
  const driftPosition = drift.getAttribute("position") as THREE.BufferAttribute;
  const driftStar = drift.getAttribute("star") as THREE.BufferAttribute;
  driftPosition.setUsage(THREE.DynamicDrawUsage);
  driftStar.setUsage(THREE.DynamicDrawUsage);
  // Each drifting star keeps an angle and distance from the tunnel axis, outside the rings.
  const driftLayout = Array.from({ length: STARS }, () => ({
    angle: Math.random() * Math.PI * 2,
    distance: RADIUS * 1.8 + Math.pow(Math.random(), 0.7) * 30,
    offset: Math.random() * DEPTH,
    size: 3 + Math.pow(Math.random(), 4) * 14,
    phase: Math.random() * 40,
  }));

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 1, 0.55, 0.1);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let target: VisualLook = { ...DEFAULT_VISUAL_LOOK };
  const look = { ...target };
  const color = new THREE.Color(),
    tint = new THREE.Color(),
    white = new THREE.Color(1, 1, 1);
  const palette = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
  const mood = [1, 0, 0, 0],
    moodTarget = [1, 0, 0, 0];
  const here = new THREE.Vector2(),
    point = new THREE.Vector2(),
    next = new THREE.Vector2();
  const ahead = new THREE.Vector3();
  const dummy = new THREE.Object3D();
  const ringMatrix = new THREE.Matrix4(),
    dotMatrix = new THREE.Matrix4();
  let width = 0,
    height = 0,
    pixelRatio = 0;
  let previous: number | undefined;
  let sceneTime = 0;
  // Distance flown down the tunnel, and how fast it is flowing.
  let travel = 0,
    speed = 0;
  let previousBeat = -1,
    previousLane = -1;
  let burst = 0,
    level = 0,
    hue = 0,
    hueGoal = 0,
    beats = 0,
    vinylSpin = 0,
    dotSpin = 0;
  // The decks' tracks, mapped ahead of time; the hits sounding now; the melody's hue.
  let music: MusicLane[] = [];
  const maps = new Map<string, SongMap | null>();
  let kickNow = 0,
    snareNow = 0,
    hatNow = 0,
    melodyX = 1,
    melodyY = 0,
    melodyClarity = 0;
  const melodyColor = new THREE.Color();
  // Each ring's lights rise quickly when a hit reaches it and fade slowly, so nothing flickers.
  const glowKick = new Float32Array(RINGS),
    glowSnare = new Float32Array(RINGS),
    glowHat = new Float32Array(RINGS),
    glowBeat = new Float32Array(RINGS);
  const ease = (values: Float32Array, i: number, value: number, dt: number) => {
    const rate = value > values[i]! ? 14 : 2.5;
    return (values[i] = values[i]! + (value - values[i]!) * (1 - Math.exp(-dt * rate)));
  };
  // Only the hits that stand out: the main kicks and backbeats, not every ghost note.
  const significant = (value: number, from: number) => THREE.MathUtils.smoothstep(value, from, 0.95);
  // Without a waveform, fall back to the live bass and a ripple per beat.
  let bassAverage = 0,
    kick = 0,
    beatAge = Infinity,
    beatStrength = 0;

  return {
    setLook(next) {
      target = next;
    },
    setMusic(lanes) {
      music = lanes;
    },
    draw(time, rgba, energy, motion) {
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
      const blend = 1 - Math.exp(-dt * 2);
      for (const key of ["intensity", "motion", "density", "halloween"] as const)
        look[key] += (target[key] - look[key]) * blend;
      const damping = (reduced.matches ? 0.08 : 1) * look.motion;
      sceneTime += dt * damping;
      const t = sceneTime;
      const intensity = look.intensity;

      // Follow the loudest deck: its beats drive the steps.
      let lane = 0;
      for (let k = 1; k < LANES; k++) if ((energy[k * 4] ?? 0) > (energy[lane * 4] ?? 0)) lane = k;
      const e = lane * 4;
      const loud = Math.min(1, Math.sqrt(Math.max(0, energy[e] ?? 0)) * 1.7);
      level += (loud - level) * (1 - Math.exp(-dt * 12));
      const low = Math.min(1, Math.max(0, energy[e + 1] ?? 0));
      const mid = Math.min(1, Math.max(0, energy[e + 2] ?? 0));
      const high = Math.min(1, Math.max(0, energy[e + 3] ?? 0));
      // Read the moment's mood from loudness and band balance, then drift there over seconds.
      const calm = 1 - THREE.MathUtils.smoothstep(level, 0.2, 0.6);
      const bands = low * 1.1 + mid + high * 1.6 + 1e-4;
      moodTarget[0] = calm;
      moodTarget[1] = (1 - calm) * Math.pow((low * 1.1) / bands, 1.5);
      moodTarget[2] = (1 - calm) * Math.pow(mid / bands, 1.5);
      moodTarget[3] = (1 - calm) * Math.pow((high * 1.6) / bands, 1.5);
      const moodSum = moodTarget.reduce((sum, w) => sum + w, 0) || 1;
      const moodBlend = 1 - Math.exp(-dt * 0.7);
      mood.forEach((w, m) => (mood[m] = w + (moodTarget[m]! / moodSum - w) * moodBlend));
      palette.forEach((swatch, j) => {
        swatch.setRGB(0, 0, 0);
        MOODS.forEach((colors, m) => swatch.add(tint.copy(colors[j]!).multiplyScalar(mood[m]!)));
      });
      const deck = music[lane];
      let map: SongMap | null = null;
      if (deck?.trackId && deck.waveform) {
        const key = `${deck.trackId}:${deck.waveform.peaks.length}`;
        if (!maps.has(key)) maps.set(key, buildSongMap(deck.waveform));
        map = maps.get(key) ?? null;
      }
      const songTime = deck?.time ?? 0;
      const aheadSeconds = (AHEAD_BEATS * 60) / (deck?.bpm || 120);
      // The melody's note tints the palette, gliding around the colour wheel as the riff moves.
      if (deck?.spectrum && deck.sampleRate && level > 0.03) {
        const note = melody(deck.spectrum, deck.sampleRate);
        const glide = 1 - Math.exp(-dt * 1.5 * note.clarity);
        melodyX += (Math.cos(note.hue * Math.PI * 2) - melodyX) * glide;
        melodyY += (Math.sin(note.hue * Math.PI * 2) - melodyY) * glide;
        melodyClarity += (note.clarity - melodyClarity) * (1 - Math.exp(-dt * 3));
      } else melodyClarity *= Math.exp(-dt * 2);
      const melodyHue = (Math.atan2(melodyY, melodyX) / (Math.PI * 2) + 1) % 1;
      melodyColor.setHSL(melodyHue, 0.85, 0.6);
      for (const swatch of palette) swatch.lerp(melodyColor, Math.min(0.35, melodyClarity * 0.4));
      const phase = motion[e + 3] ?? 0;
      const beat = Math.floor(phase);
      const playing = loud > 0.025;
      if (lane !== previousLane) previousBeat = beat;
      if (beat !== previousBeat && previousBeat >= 0 && playing) {
        // The first beat of every bar lands harder.
        const downbeat = ++beats % 4 === 0;
        burst = downbeat ? 1.4 : 1;
        beatStrength = burst;
        beatAge = 0;
        if (downbeat) hueGoal += 1;
      }
      beatAge += dt;
      bassAverage += (low - bassAverage) * (1 - Math.exp(-dt * 1.5));
      kick = Math.max(kick * Math.exp(-dt * 6), Math.min(1, Math.max(0, low - bassAverage * 1.08) * 6));
      if (!playing) kick = 0;
      const decay = Math.exp(-dt * 7);
      if (map && playing) {
        const from = songTime - Math.max(dt, 0.02);
        kickNow = Math.max(kickNow * decay, significant(peakIn(map.kick, map, from, songTime), 0.55));
        snareNow = Math.max(snareNow * decay, significant(peakIn(map.snare, map, from, songTime), 0.6));
        hatNow = Math.max(hatNow * decay, significant(peakIn(map.hat, map, from, songTime), 0.8));
        kick = Math.max(kick, kickNow);
      } else {
        kickNow *= decay;
        snareNow *= decay;
        hatNow *= decay;
      }
      // Passages, not just loudness: breakdowns glide slowly, drops rush.
      const drive = map && playing ? (map.section[Math.floor(songTime / map.step)] ?? level) : level;
      previousBeat = beat;
      previousLane = lane;
      burst *= Math.exp(-dt * 2.2);
      if (!playing) burst = 0;
      // Never stop: cruise slowly in silence, a little quicker with music, and let each beat
      // swell the glide softly, peaking on the beat and easing off before the next one.
      const swell = playing ? 0.5 + 0.5 * Math.cos((phase - beat) * Math.PI * 2) : 0;
      const cruise =
        SPACING * (playing ? 0.5 + drive * 0.9 : 0.4) * (0.75 + swell * (0.4 + drive * 0.6));
      speed += (cruise * damping - speed) * (1 - Math.exp(-dt * 2.5));
      travel += speed * dt;
      hueGoal += playing ? 0 : dt * 0.05;
      hue += (hueGoal - hue) * (1 - Math.exp(-dt * 1.2));
      const pulse = burst * Math.min(1.5, damping) * intensity * 0.9;
      const punch = kick * Math.min(1.5, damping) * intensity;

      // Ride the centre line and look down the bend ahead, so the hole swings around the screen.
      center(travel, here);
      center(travel + LOOK_AHEAD, point);
      camera.position.set(0, 0, 0);
      ahead.set(point.x - here.x, point.y - here.y, -LOOK_AHEAD);
      camera.up.set(Math.sin(travel * 0.02 + t * 0.03) * 0.4, 1, 0).normalize();
      camera.lookAt(ahead);
      // Kicks punch the view in a touch, like being pressed into the hole.
      camera.fov = 70 - punch * 2 - pulse * 0.8;
      camera.updateProjectionMatrix();

      const brightness = (0.35 + drive * 0.5 + level * 0.2 + pulse * 0.3 + punch * 0.3) * intensity;
      // The beat's ripple starts at the far end and rushes toward the lens.
      const front = DEPTH - beatAge * 70;
      const rippleFade = beatStrength * Math.exp(-beatAge * 1.2) * (playing ? 1 : 0);
      // Mids quicken the dots around each ring.
      dotSpin += dt * damping * (0.2 + level * 0.3 + mid * 1.2);
      // Records turn faster when the bass takes over.
      vinylSpin += dt * damping * (0.5 + level * 0.8 + low * 1.6);
      for (let i = 0; i < RINGS; i++) depths[i] = (((i * SPACING - travel) % DEPTH) + DEPTH) % DEPTH;
      order.sort((a, b) => depths[b]! - depths[a]!);
      order.forEach((ring, slot) => (slots[ring] = slot));
      const dotCount = Math.round(DOTS_PER_RING * Math.max(0.15, look.density));
      dots.count = RINGS * dotCount;
      for (let i = 0; i < RINGS; i++) {
        const depth = depths[i]!;
        const s = travel + depth;
        const u = depth / DEPTH;
        // Rings melt in from the darkness and fade just before they pass the lens.
        const fade = Math.pow(1 - u, 1.3) * THREE.MathUtils.smoothstep(depth, 0.4, 2.4);
        // The far end shows what is playing now; older sound flows toward the lens.
        const sample = (lane * 256 + Math.round((1 - u) * 255)) * 4;
        const amplitude = (rgba[sample + 3] ?? 0) / 255;
        // This ring's moment in the song, and the hits that land within its slice of time.
        let ringKick = 0,
          ringSnare = 0,
          ringHat = 0,
          ringBeat = 0,
          ringAmplitude = amplitude * level;
        if (map && playing) {
          const moment = songTime + ((depth - NOW_DEPTH) / DEPTH) * aheadSeconds;
          const half = ((SPACING / DEPTH) * aheadSeconds) / 2;
          ringKick = significant(peakIn(map.kick, map, moment - half, moment + half), 0.55);
          ringSnare = significant(peakIn(map.snare, map, moment - half, moment + half), 0.6);
          ringHat = significant(peakIn(map.hat, map, moment - half, moment + half), 0.8) * 0.5;
          // Only bar starts are marked; ordinary beats are already carried by the kicks.
          ringBeat = beatIn(map, moment - half, moment + half) > 1 ? 1 : 0;
          ringAmplitude = peakIn(map.amplitude, map, moment - half, moment + half);
        } else {
          ringKick = rippleFade * Math.exp(-(((depth - front) / 5) ** 2));
        }
        ringKick = ease(glowKick, i, ringKick, dt);
        ringSnare = ease(glowSnare, i, ringSnare, dt);
        ringHat = ease(glowHat, i, ringHat, dt);
        ringBeat = ease(glowBeat, i, ringBeat, dt);
        const hit = Math.max(ringKick, ringSnare * 0.8, ringHat * 0.3) * intensity;
        const radius =
          RADIUS *
          (1 + pulse * 0.06 * (1 - u) + punch * 0.04 + ringKick * 0.12 + ringBeat * 0.03 + ringAmplitude * 0.1);
        const glow = brightness * (0.7 + hit * 0.6 + ringBeat * 0.2);
        const ripple = ringKick;
        center(s, point);
        center(s + 0.5, next);
        const x = point.x - here.x,
          y = point.y - here.y;
        dummy.position.set(x, y, -depth);
        // Each ring faces along the bend, so the tunnel walls read as one continuous curve.
        dummy.rotation.set((next.y - point.y) * 2, -(next.x - point.x) * 2, i * 0.21 + t * 0.1);
        // Snares squash a ring into an oval, as if it were struck.
        dummy.scale.set(radius * (1 + ringSnare * 0.06), radius * (1 - ringSnare * 0.03), radius);
        dummy.updateMatrix();
        rings.setMatrixAt(i, dummy.matrix);
        const flow = i * 0.37 + hue + t * 0.04;
        paletteAt(palette, flow, color);
        tint.setRGB((rgba[sample] ?? 0) / 255, (rgba[sample + 1] ?? 0) / 255, (rgba[sample + 2] ?? 0) / 255);
        // Snares and bar starts flash toward white; the song's own waveform colour shows through.
        color.lerp(tint, 0.25 * level).lerp(white, Math.min(0.3, ringSnare * 0.2 + ringBeat * 0.1));
        color.multiplyScalar(fade * glow * 1.5);
        rings.setColorAt(i, color);

        if (faces.visible) {
          const slot = slots[i]!;
          faces.setMatrixAt(slot, dummy.matrix);
          paletteAt(palette, flow, color);
          color.lerp(tint, 0.25 * level).multiplyScalar(glow);
          faceAttributes.aColor.setXYZ(slot, color.r, color.g, color.b);
          paletteAt(palette, flow + 1, color).multiplyScalar(glow);
          faceAttributes.aAccent.setXYZ(slot, color.r, color.g, color.b);
          // Eyes squeeze their pupils on each beat, then relax; the nearest stay wide for the fly-through.
          const squeeze = Math.max(pulse * 0.08, ringKick * 0.2) * THREE.MathUtils.smoothstep(u, 0.05, 0.2);
          // Distant eyes blink now and then; never one we are about to pass through.
          const wink = (t * 0.06 + i * 0.618) % 1;
          const open = depth > 20 && wink < 0.025 ? 1 - Math.sin((wink / 0.025) * Math.PI) : 1;
          faceAttributes.aParams.setXYZW(
            slot,
            fade,
            shape === "eyes" ? t * 0.15 + i : vinylSpin + i * 1.3,
            shape === "eyes" ? 1.05 - squeeze : 1,
            open,
          );
          faceAttributes.aWave.setXY(slot, ringAmplitude, i * 2.3);
          faceAttributes.aHits.setXYZW(slot, ringKick, ringSnare, ringHat, ringBeat);
        }

        ringMatrix.copy(dummy.matrix);
        const spin = (i % 2 ? 1 : -1) * dotSpin + i * 0.4;
        for (let k = 0; k < dotCount; k++) {
          const angle = spin + (k / dotCount) * Math.PI * 2;
          // Dots ride just outside their ring, in the ring's own tilted frame.
          // Highs make the dots sparkle and swell.
          const sparkle = 1 + (map ? ringHat * 0.6 : high * 0.5) * (0.5 + 0.5 * Math.sin(time * 3 + k * 2.1 + i));
          const size = 0.022 * (1 + pulse * 0.3 + ripple * 0.3) * (1 + (k % 3) * 0.3) * sparkle;
          dotMatrix
            .makeScale(size, size, size)
            .setPosition(Math.cos(angle) * 1.14, Math.sin(angle) * 1.14, 0);
          dotMatrix.premultiply(ringMatrix);
          const slot = k * RINGS + i;
          dots.setMatrixAt(slot, dotMatrix);
          // Colours run around each ring as its dots spin.
          paletteAt(palette, flow + 1 + (k / dotCount) * 3, color).multiplyScalar(fade * glow * 1.2 * sparkle);
          dots.setColorAt(slot, color);
        }
      }
      faces.instanceMatrix.needsUpdate = true;
      for (const attribute of Object.values(faceAttributes)) attribute.needsUpdate = true;
      faceMaterial.uniforms.halloween!.value = look.halloween;
      for (const mesh of [rings, dots]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }

      // Nearer stars stream past more slowly than the rings, so space feels deep around the tunnel.
      const starTravel = travel * 0.55;
      driftLayout.forEach((star, i) => {
        const depth = (((star.offset - starTravel) % DEPTH) + DEPTH) % DEPTH;
        center(travel + depth, point);
        const angle = star.angle + t * 0.02;
        driftPosition.setXYZ(
          i,
          point.x - here.x + Math.cos(angle) * star.distance,
          point.y - here.y + Math.sin(angle) * star.distance,
          -depth,
        );
        const fade = THREE.MathUtils.smoothstep(depth, 0.5, 6) * (1 - THREE.MathUtils.smoothstep(depth, DEPTH * 0.7, DEPTH));
        driftStar.setXYZ(i, star.size, star.phase, fade);
      });
      driftPosition.needsUpdate = true;
      driftStar.needsUpdate = true;
      starMaterial.uniforms.time!.value = time;
      starMaterial.uniforms.pixelRatio!.value = pixelRatio;
      starMaterial.uniforms.glow!.value =
        0.7 + intensity * 0.3 + pulse * 0.1 + punch * 0.2 + (map ? hatNow * 0.15 : high * 0.15);

      center(travel + DEPTH, point);
      core.position.set(point.x - here.x, point.y - here.y, -DEPTH);
      core.lookAt(camera.position);
      paletteAt(palette, hue, coreMaterial.uniforms.color!.value as THREE.Color);
      coreMaterial.uniforms.strength!.value = (0.3 + level * 0.4 + pulse * 0.4 + low * 0.2) * intensity;
      bloom.strength = 0.55 + intensity * 0.4 + pulse * 0.08 + punch * 0.12 + snareNow * 0.08;

      composer.render(dt);
    },
    dispose() {
      composer.dispose();
      for (const item of disposables) item.dispose();
      rings.dispose();
      dots.dispose();
      faces.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
