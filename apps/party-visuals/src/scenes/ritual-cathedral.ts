import { createDanceMotion, type MusicDance } from "../../../dj-monitor/src/music-dance.js";
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { DEFAULT_VISUAL_LOOK } from "../../../dj-monitor/src/visual-presets.js";
import { waveformBeat } from "../../../dj-monitor/src/waveform-signal.js";
import type { MusicLane, SceneEngine } from "../scenes.js";
import { createWaveformPulse } from "../music/waveform-pulse.js";

/** A fixed-cost Gothic nave: instanced stonework, painted glass, and a sculpted pumpkin reliquary. */
export async function createRitualCathedral(host: HTMLCanvasElement): Promise<SceneEngine> {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x070b11);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.setAttribute("aria-hidden", "true");
  host.after(renderer.domElement);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b1420, 0.025);
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 90);
  camera.position.set(0.5, 3.1, 10.8);
  const resources: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(value: T): T => (resources.push(value), value);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = keep(pmrem.fromScene(room, 0.06));
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.28;
  room.dispose();
  pmrem.dispose();

  // Seeded surface wear stays fixed between frames and across scene reloads.
  let seed = 4381;
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const stoneCanvas = document.createElement("canvas");
  stoneCanvas.width = stoneCanvas.height = 512;
  const stone = stoneCanvas.getContext("2d")!;
  stone.fillStyle = "#77746e";
  stone.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 16000; i++) {
    const shade = Math.floor(65 + random() * 95);
    stone.fillStyle = `rgba(${shade},${shade},${shade},.24)`;
    stone.fillRect(random() * 512, random() * 512, 1 + random() * 3, 1 + random() * 3);
  }
  for (let row = 0; row < 8; row++) {
    const y = row * 64;
    stone.strokeStyle = "#353632";
    stone.lineWidth = 3;
    stone.beginPath();
    stone.moveTo(0, y);
    stone.lineTo(512, y);
    stone.stroke();
    stone.strokeStyle = "#aaa499";
    stone.lineWidth = 1;
    stone.beginPath();
    stone.moveTo(0, y + 3);
    stone.lineTo(512, y + 3);
    stone.stroke();
    for (let col = 0; col < 4; col++) {
      const x = col * 128 + (row % 2) * 64;
      stone.strokeStyle = "#484943";
      stone.lineWidth = 2;
      stone.beginPath();
      stone.moveTo(x, y);
      stone.lineTo(x, y + 64);
      stone.stroke();
      stone.lineWidth = 0.7;
      stone.beginPath();
      stone.moveTo(x + 22, y);
      stone.lineTo(x + 34, y + 17);
      stone.lineTo(x + 28, y + 26);
      stone.stroke();
    }
  }
  const masonry = keep(new THREE.CanvasTexture(stoneCanvas));
  masonry.colorSpace = THREE.SRGBColorSpace;
  masonry.wrapS = masonry.wrapT = THREE.RepeatWrapping;
  masonry.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const stoneMaterial = keep(
    new THREE.MeshStandardMaterial({
      color: 0x827a73,
      map: masonry,
      bumpMap: masonry,
      bumpScale: 0.055,
      roughness: 0.91,
    }),
  );
  const trimMaterial = keep(
    new THREE.MeshStandardMaterial({
      color: 0x716558,
      map: masonry,
      bumpMap: masonry,
      bumpScale: 0.025,
      roughness: 0.65,
    }),
  );
  const bronze = keep(
    new THREE.MeshStandardMaterial({ color: 0x8c6130, metalness: 0.83, roughness: 0.36 }),
  );
  const black = keep(
    new THREE.MeshStandardMaterial({ color: 0x17171e, metalness: 0.38, roughness: 0.34 }),
  );
  type Placement = {
    x: number;
    y: number;
    z: number;
    sx?: number;
    sy?: number;
    sz?: number;
    rx?: number;
    ry?: number;
    rz?: number;
  };
  const dummy = new THREE.Object3D();
  function instances(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    placements: Placement[],
  ) {
    const mesh = keep(new THREE.InstancedMesh(geometry, material, placements.length));
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]!;
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0);
      dummy.scale.set(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
    return mesh;
  }
  function mesh(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ) {
    const object = new THREE.Mesh(geometry, material);
    object.position.set(x, y, z);
    scene.add(object);
    return object;
  }
  const box = keep(new THREE.BoxGeometry(1, 1, 1));
  const cylinder = keep(new THREE.CylinderGeometry(1, 1, 1, 16));
  const walls: Placement[] = [];
  const shafts: Placement[] = [];
  const capitals: Placement[] = [];
  const ribs: Placement[] = [];
  for (let bay = 0; bay < 8; bay++) {
    const z = 13 - bay * 4.4;
    ribs.push({ x: 0, y: 0, z });
    for (const side of [-1, 1]) {
      walls.push({ x: side * 6.5, y: 5.6, z, sx: 0.8, sy: 11.2, sz: 4.4 });
      // Bundled columns carry the intersecting vault ribs.
      for (let k = -1; k <= 1; k++)
        shafts.push({
          x: side * 5.45 + k * 0.24,
          y: 3.1,
          z: z + Math.abs(k) * 0.2,
          sx: k === 0 ? 0.27 : 0.15,
          sy: 6.2,
          sz: k === 0 ? 0.27 : 0.15,
        });
      for (const [y, scale, height] of [
        [0.16, 1.15, 0.32],
        [0.43, 0.85, 0.2],
        [6, 0.9, 0.2],
        [6.22, 1.08, 0.22],
      ]) {
        capitals.push({ x: side * 5.45, y: y!, z, sx: scale!, sy: height!, sz: scale! });
      }
    }
  }
  walls.push({ x: 0, y: 5.6, z: -21, sx: 14, sy: 11.2, sz: 0.7 });
  instances(box, stoneMaterial, walls);
  instances(cylinder, trimMaterial, shafts);
  instances(box, trimMaterial, capitals);
  // Pointed arches use one reusable swept curve, with a second slender moulding.
  const archCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-5.45, 6.1, 0),
    new THREE.Vector3(-4.6, 8.1, 0),
    new THREE.Vector3(-2.2, 9.5, 0),
    new THREE.Vector3(0, 10.6, 0),
    new THREE.Vector3(2.2, 9.5, 0),
    new THREE.Vector3(4.6, 8.1, 0),
    new THREE.Vector3(5.45, 6.1, 0),
  ]);
  instances(keep(new THREE.TubeGeometry(archCurve, 64, 0.19, 8, false)), trimMaterial, ribs);
  instances(
    keep(new THREE.TubeGeometry(archCurve, 64, 0.065, 6, false)),
    bronze,
    ribs.flatMap((p) => [-0.27, 0.27].map((z) => ({ ...p, z: p.z + z, y: 0.08 }))),
  );
  // Longitudinal vault spines and side cornices reinforce depth.
  instances(
    box,
    trimMaterial,
    [-1, 1].flatMap((side) => [
      { x: side * 5.5, y: 6.2, z: -3, sx: 0.45, sy: 0.32, sz: 36 },
      { x: side * 3.4, y: 9.1, z: -3, sx: 0.16, sy: 0.16, sz: 36 },
    ]),
  );
  mesh(box, black, 0, 11.3, -3).scale.set(14, 0.5, 38);

  const floorMap = keep(masonry.clone());
  floorMap.repeat.set(5, 16);
  floorMap.needsUpdate = true;
  const floorMaterial = keep(
    new THREE.MeshStandardMaterial({
      color: 0x252a2d,
      map: floorMap,
      bumpMap: floorMap,
      bumpScale: 0.025,
      metalness: 0.48,
      roughness: 0.24,
    }),
  );
  const floor = mesh(keep(new THREE.PlaneGeometry(14, 42)), floorMaterial, 0, -0.02, -3);
  floor.rotation.x = -Math.PI / 2;
  instances(
    box,
    bronze,
    [-1, 1].map((side) => ({ x: side * 2.65, y: 0.015, z: -3, sx: 0.025, sy: 0.015, sz: 39 })),
  );

  // Hand-painted radial glass: lead outlines, jewel facets, scalloped petals, and a central moon.
  const glassCanvas = document.createElement("canvas");
  glassCanvas.width = glassCanvas.height = 1024;
  const glass = glassCanvas.getContext("2d")!;
  glass.translate(512, 512);
  glass.fillStyle = "#081319";
  glass.beginPath();
  glass.arc(0, 0, 500, 0, Math.PI * 2);
  glass.fill();
  for (let ring = 0; ring < 5; ring++) {
    const inner = 82 + ring * 79,
      outer = inner + 76;
    for (let petal = 0; petal < 24; petal++) {
      const a = (petal / 24) * Math.PI * 2,
        b = ((petal + 1) / 24) * Math.PI * 2;
      glass.beginPath();
      glass.arc(0, 0, inner, a, b);
      glass.lineTo(Math.cos(b) * outer, Math.sin(b) * outer);
      glass.arc(0, 0, outer, b, a, true);
      glass.closePath();
      const colors = ["#d49c42", "#77b8af", "#2c687c", "#b56530", "#b9d4b8", "#284b67"];
      glass.fillStyle = colors[(petal + ring * 3) % colors.length]!;
      glass.fill();
      glass.strokeStyle = "#14212a";
      glass.lineWidth = 7;
      glass.stroke();
      const mid = (a + b) / 2,
        radius = (inner + outer) / 2;
      glass.save();
      glass.translate(Math.cos(mid) * radius, Math.sin(mid) * radius);
      glass.rotate(mid);
      glass.fillStyle = "#fff0b144";
      glass.beginPath();
      glass.ellipse(0, 0, 28, Math.max(8, radius * 0.07), 0, 0, Math.PI * 2);
      glass.fill();
      glass.strokeStyle = "#1d2830";
      glass.lineWidth = 3;
      glass.stroke();
      glass.restore();
    }
  }
  glass.fillStyle = "#f4d89a";
  glass.beginPath();
  glass.arc(0, 0, 67, 0, Math.PI * 2);
  glass.fill();
  for (let i = 0; i < 2300; i++) {
    const x = random() * 1000 - 500,
      y = random() * 1000 - 500;
    if (Math.hypot(x, y) > 485) continue;
    glass.fillStyle = random() > 0.5 ? "#fff5d019" : "#031c2b28";
    glass.fillRect(x, y, 2 + random() * 10, 1 + random() * 3);
  }
  const glassMap = keep(new THREE.CanvasTexture(glassCanvas));
  glassMap.colorSpace = THREE.SRGBColorSpace;
  const windowMaterial = keep(new THREE.MeshBasicMaterial({ map: glassMap, color: 0xfff2d4 }));
  mesh(keep(new THREE.CircleGeometry(3.1, 96)), windowMaterial, 0, 7.1, -20.55);
  // A deliberately subdued glass reflection is broken by wet stone joints.
  // One translucent plane avoids a second scene render or an expensive reflection target.
  const reflectionMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { glass: { value: glassMap } },
      vertexShader:
        "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
      fragmentShader: `
      uniform sampler2D glass;varying vec2 vUv;
      void main(){
        vec2 uv=vUv;uv.x+=sin(uv.y*190.)*.006+sin(uv.y*473.)*.003;
        vec3 color=texture2D(glass,vec2(uv.x,1.-uv.y)).rgb;
        float edge=pow(max(0.,sin(vUv.x*3.14159)),2.)*sin(vUv.y*3.14159);
        float joint=step(.025,fract(vUv.y*16.));
        gl_FragColor=vec4(color,edge*joint*.13);
      }`,
    }),
  );
  const reflection = mesh(keep(new THREE.PlaneGeometry(7, 20)), reflectionMaterial, 0, 0.003, -8);
  reflection.rotation.x = -Math.PI / 2;
  const torus = keep(new THREE.TorusGeometry(1, 0.045, 8, 96));
  instances(
    torus,
    trimMaterial,
    [3.17, 3.35, 3.52].map((radius) => ({
      x: 0,
      y: 7.1,
      z: -20.4,
      sx: radius,
      sy: radius,
      sz: radius,
    })),
  );
  instances(
    box,
    bronze,
    Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return {
        x: Math.cos(a) * 1.85,
        y: 7.1 + Math.sin(a) * 1.85,
        z: -20.35,
        sx: 2.35,
        sy: 0.045,
        sz: 0.08,
        rz: a,
      };
    }),
  );

  // Altar steps, bevel-like stacked profiles, and a scalloped bronze reliquary.
  instances(box, black, [
    { x: 0, y: 0.15, z: -8, sx: 5.1, sy: 0.3, sz: 4 },
    { x: 0, y: 0.4, z: -8, sx: 4.4, sy: 0.2, sz: 3.4 },
    { x: 0, y: 0.8, z: -8, sx: 2.6, sy: 0.6, sz: 2 },
    { x: 0, y: 1.15, z: -8, sx: 3.2, sy: 0.15, sz: 2.5 },
  ]);
  instances(
    box,
    bronze,
    [-1.2, 0, 1.2].map((x) => ({ x, y: 0.8, z: -6.98, sx: 0.055, sy: 0.55, sz: 0.04 })),
  );
  const contactMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexShader:
        "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
      fragmentShader:
        "varying vec2 vUv;void main(){float d=length((vUv-.5)*2.);gl_FragColor=vec4(.008,.004,.003,pow(max(0.,1.-d),1.6)*.8);}",
    }),
  );
  const contact = mesh(keep(new THREE.PlaneGeometry(3.1, 2.4)), contactMaterial, 0, 1.231, -8);
  contact.rotation.x = -Math.PI / 2;
  const pumpkinGeometry = keep(new THREE.SphereGeometry(1, 96, 56));
  const position = pumpkinGeometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i),
      y = position.getY(i),
      z = position.getZ(i);
    const a = Math.atan2(z, x),
      ribs = 1 + 0.075 * Math.cos(a * 11);
    const dent = 0.12 * Math.pow(Math.abs(y), 12);
    position.setXYZ(i, x * ribs * 1.35, y * (1.08 - dent), z * ribs * 1.2);
  }
  pumpkinGeometry.computeVertexNormals();
  const pumpkinMaterial = keep(
    new THREE.MeshPhysicalMaterial({
      color: 0xbb4c13,
      roughness: 0.46,
      metalness: 0.08,
      clearcoat: 0.19,
      clearcoatRoughness: 0.5,
      bumpMap: masonry,
      bumpScale: 0.012,
    }),
  );
  // Pivot at the altar contact point so squash and bounce keep every facial part attached.
  const pumpkin = new THREE.Group();
  pumpkin.position.set(0, 1.23, -8);
  scene.add(pumpkin);
  const firstPumpkinPart = scene.children.length;
  mesh(pumpkinGeometry, pumpkinMaterial, 0, 2.24, -8);
  const stemCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 3.15, -8),
    new THREE.Vector3(0.03, 3.48, -8),
    new THREE.Vector3(0.22, 3.67, -8.05),
    new THREE.Vector3(0.28, 3.7, -8.12),
  ]);
  mesh(
    keep(new THREE.TubeGeometry(stemCurve, 14, 0.12, 9, false)),
    keep(new THREE.MeshStandardMaterial({ color: 0x4d4930, roughness: 0.9, map: masonry })),
    0,
    0,
    0,
  );
  const carveMaterial = keep(
    new THREE.MeshStandardMaterial({ color: 0x140a05, roughness: 1, transparent: true }),
  );
  const emberMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xffa029, transparent: true }));
  // Tessellated carvings follow the actual ribbed shell, including in side-on camera shots.
  const carve = (
    shape: THREE.Shape,
    x: number,
    y: number,
    scale: number,
    material: THREE.Material,
    lift: number,
  ) => {
    const flat = new THREE.ShapeGeometry(shape);
    const vertices = flat.getAttribute("position");
    const indices = flat.getIndex()!;
    const points: number[] = [];
    const project = (u: number, v: number) => {
      const px = x + u * scale,
        py = y + v * scale;
      let low = -1,
        high = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (low + high) / 2;
        if (mid * (1.08 - 0.12 * Math.pow(Math.abs(mid), 12)) < py) low = mid;
        else high = mid;
      }
      const latitude = (low + high) / 2;
      const radius = Math.sqrt(Math.max(0, 1 - latitude * latitude));
      low = -Math.PI / 2;
      high = Math.PI / 2;
      for (let i = 0; i < 24; i++) {
        const mid = (low + high) / 2;
        const ribs = 1 + 0.075 * Math.cos((Math.PI / 2 - mid) * 11);
        if (Math.sin(mid) * radius * ribs * 1.35 < px) low = mid;
        else high = mid;
      }
      const angle = (low + high) / 2;
      const ribs = 1 + 0.075 * Math.cos((Math.PI / 2 - angle) * 11);
      points.push(px, py, Math.cos(angle) * radius * ribs * 1.2 + lift);
    };
    const subdivide = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2, depth: number) => {
      if (!depth) {
        project(a.x, a.y);
        project(b.x, b.y);
        project(c.x, c.y);
        return;
      }
      const ab = a.clone().add(b).multiplyScalar(0.5);
      const bc = b.clone().add(c).multiplyScalar(0.5);
      const ca = c.clone().add(a).multiplyScalar(0.5);
      subdivide(a, ab, ca, depth - 1);
      subdivide(ab, b, bc, depth - 1);
      subdivide(ca, bc, c, depth - 1);
      subdivide(ab, bc, ca, depth - 1);
    };
    for (let i = 0; i < indices.count; i += 3) {
      const at = (n: number) =>
        new THREE.Vector2(vertices.getX(indices.getX(n)), vertices.getY(indices.getX(n)));
      subdivide(at(i), at(i + 1), at(i + 2), 3);
    }
    flat.dispose();
    const geometry = keep(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    geometry.computeVertexNormals();
    return mesh(geometry, material, 0, 2.24, -8);
  };
  for (const side of [-1, 1]) {
    const triangle = new THREE.Shape();
    triangle.moveTo(-0.24, -0.12);
    triangle.lineTo(0.23, -0.12);
    triangle.lineTo(side * 0.07, 0.25);
    triangle.closePath();
    carve(triangle, side * 0.48, 0.21, 1, carveMaterial, 0.018);
    carve(triangle, side * 0.48, 0.21, 0.7, emberMaterial, 0.026);
  }
  const grin = new THREE.Shape();
  grin.moveTo(-0.68, 0.04);
  grin.lineTo(-0.43, -0.16);
  grin.lineTo(-0.23, -0.19);
  grin.lineTo(-0.18, -0.06);
  grin.lineTo(0.02, -0.08);
  grin.lineTo(0.05, -0.22);
  grin.lineTo(0.36, -0.15);
  grin.lineTo(0.64, 0.04);
  grin.quadraticCurveTo(0, -0.55, -0.68, 0.04);
  carve(grin, 0, -0.26, 1.05, carveMaterial, 0.018);
  carve(grin, 0, -0.26, 0.92, emberMaterial, 0.026);
  scene.updateMatrixWorld(true);
  for (const part of scene.children.slice(firstPumpkinPart)) pumpkin.attach(part);
  const ritualMaterial = keep(bronze.clone());
  ritualMaterial.transparent = true;
  const ritual = new THREE.Group();
  ritual.position.set(0, 2.6, -9.4);
  scene.add(ritual);
  for (const radius of [1.85, 2.08, 2.17]) {
    const ring = new THREE.Mesh(torus, ritualMaterial);
    ring.scale.setScalar(radius);
    ritual.add(ring);
  }
  const sigils: Placement[] = [];
  for (let i = 0; i < 48; i++) {
    // Prefixes retain evenly distributed markings as density changes.
    const a = (((i % 12) * 4 + Math.floor(i / 12)) / 48) * Math.PI * 2;
    sigils.push({
      x: Math.sin(a) * 2.03,
      y: 2.6 + Math.cos(a) * 2.03,
      z: -9.38,
      sx: 0.026,
      sy: i % 4 ? 0.12 : 0.24,
      sz: 0.04,
      rz: -a,
    });
  }
  const sigilMesh = instances(box, ritualMaterial, sigils);
  scene.updateMatrixWorld(true);
  ritual.attach(sigilMesh);

  // Eighty candles share geometry and materials; only four lights illuminate the nave.
  const candles: Placement[] = [],
    bases: Placement[] = [],
    flames: Placement[] = [];
  for (let i = 0; i < 80; i++) {
    const side = i % 2 ? -1 : 1,
      index = Math.floor(i / 2);
    const z = 10 - index * 0.76,
      x = side * (3.2 + random() * 1.3);
    const height = 0.25 + random() * 0.65;
    candles.push({
      x,
      y: height / 2 + 0.13,
      z,
      sx: 0.055 + random() * 0.04,
      sy: height,
      sz: 0.065,
    });
    bases.push({ x, y: 0.07, z, sx: 0.15, sy: 0.13, sz: 0.15 });
    flames.push({ x, y: height + 0.2, z, sx: 0.038, sy: 0.12, sz: 0.038 });
  }
  instances(
    cylinder,
    keep(new THREE.MeshStandardMaterial({ color: 0xd6b77f, roughness: 0.68 })),
    candles,
  );
  instances(cylinder, bronze, bases);
  const flameMaterial = keep(new THREE.MeshBasicMaterial({ color: 0xffd18a }));
  instances(keep(new THREE.SphereGeometry(1, 8, 8)), flameMaterial, flames);
  // Soft contact pools on stone instead of eighty shadow maps.
  const poolMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { strength: { value: 0.28 } },
      vertexShader:
        "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.);}",
      fragmentShader:
        "uniform float strength;varying vec2 vUv;void main(){float a=pow(max(0.,1.-length(vUv-.5)*2.),3.);gl_FragColor=vec4(vec3(.8,.3,.065),a*strength);}",
    }),
  );
  instances(
    keep(new THREE.PlaneGeometry(1, 1)),
    poolMaterial,
    flames.map((p) => ({ x: p.x, y: 0.012, z: p.z, sx: 2, sy: 2, rx: -Math.PI / 2 })),
  );

  scene.add(new THREE.HemisphereLight(0x648fa9, 0x372417, 1.05));
  const warm = new THREE.PointLight(0xffa349, 85, 24, 2);
  warm.position.set(0, 4.4, -5);
  scene.add(warm);
  const rim = new THREE.PointLight(0x78c0ce, 110, 28, 2);
  rim.position.set(1, 6, -14);
  scene.add(rim);
  const near = new THREE.PointLight(0xf7a85d, 55, 22, 2);
  near.position.set(-3, 3, 7);
  scene.add(near);
  const far = new THREE.PointLight(0xd5b87b, 80, 20, 2);
  far.position.set(0, 7, -19);
  scene.add(far);

  // Transparent shafts have soft radial edges and a slow dust field; no screen wash.
  const shaftMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader:
        "varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
      fragmentShader:
        "varying vec2 vUv;void main(){float edge=pow(max(0.,sin(vUv.x*3.14159)),4.);float fade=sin(vUv.y*3.14159);gl_FragColor=vec4(.25,.47,.54,edge*fade*.045);}",
    }),
  );
  for (const side of [-1, 1]) {
    const beam = mesh(
      keep(new THREE.ConeGeometry(2.8, 17, 24, 1, true)),
      shaftMaterial,
      side * 1.8,
      5.2,
      -12,
    );
    beam.rotation.x = -0.48;
    beam.rotation.z = side * 0.23;
  }
  const dustGeometry = keep(new THREE.BufferGeometry());
  const dustPositions = new Float32Array(420 * 3);
  for (let i = 0; i < 420; i++) {
    dustPositions[i * 3] = (random() - 0.5) * 11;
    dustPositions[i * 3 + 1] = random() * 10;
    dustPositions[i * 3 + 2] = 13 - random() * 34;
  }
  dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  const dustMaterial = keep(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { time: { value: 0 }, ratio: { value: 1 } },
      vertexShader:
        "uniform float time,ratio;varying float light;void main(){vec3 p=position;p.x+=sin(time*.14+p.y)*.12;p.y+=sin(time*.09+p.z)*.15;vec4 view=modelViewMatrix*vec4(p,1.);light=.22+.18*sin(p.z*3.);gl_PointSize=clamp(22./max(1.,-view.z),1.,3.)*ratio;gl_Position=projectionMatrix*view;}",
      fragmentShader:
        "varying float light;void main(){float d=length(gl_PointCoord-.5)*2.;gl_FragColor=vec4(.85,.72,.42,pow(max(0.,1.-d),2.)*light);}",
    }),
  );
  scene.add(new THREE.Points(dustGeometry, dustMaterial));

  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const bloom = keep(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.55, 0.85));
  const output = keep(new OutputPass());
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(output);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const pulse = createWaveformPulse();
  let music: MusicLane[] = [],
    look = { ...DEFAULT_VISUAL_LOOK },
    targetLook = { ...look };
  let previous: number | undefined,
    clock = 0,
    response = 0,
    bass = 0,
    cameraDrive = 0;
  let width = 0,
    height = 0,
    pixelRatio = 0;
  const restPosition = new THREE.Vector3(0.5, 3.1, 10.8);
  const restAim = new THREE.Vector3(0, 4.1, -10);
  const aim = restAim.clone();
  // All control points sit inside the central aisle, clear of candles, columns and altar.
  // A closed rail gives actual parallax without roll, FOV pumping or a screen-space wobble.
  const cameraRail = new THREE.CatmullRomCurve3(
    [
      restPosition.clone(),
      new THREE.Vector3(-1.8, 2.8, 0.4),
      new THREE.Vector3(-2.6, 3.3, -4),
      new THREE.Vector3(2.6, 3.5, -4),
      new THREE.Vector3(1.3, 5.6, -1.2),
      new THREE.Vector3(-1.4, 4.5, 6.2),
    ],
    true,
    "centripetal",
  );
  const aimRail = new THREE.CatmullRomCurve3(
    [
      restAim.clone(),
      new THREE.Vector3(0, 2.7, -8),
      new THREE.Vector3(0, 2.7, -8),
      new THREE.Vector3(0, 3.3, -9),
      new THREE.Vector3(0, 7.1, -20.4),
      new THREE.Vector3(0, 5.3, -14),
    ],
    true,
    "centripetal",
  );
  const shots = [
    "aisle approach",
    "altar tracking",
    "altar orbit",
    "rose-window reveal",
    "vault retreat",
    "nave return",
  ];
  const desiredPosition = new THREE.Vector3(),
    desiredAim = new THREE.Vector3();
  let cameraShot = "still nave";
  camera.lookAt(aim);
  let suppliedDance: MusicDance | undefined;
  const fallbackDance = createDanceMotion();
  return {
    setDance(next) {
      suppliedDance = next;
    },
    setLook(next) {
      targetLook = { ...next };
    },
    setMusic(next) {
      music = next;
    },
    status() {
      return `Ritual cathedral · ${cameraShot} · beat-locked camera journey`;
    },
    draw(time, _rgba, energy) {
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
        dustMaterial.uniforms.ratio!.value = ratio;
      }
      const dt = previous === undefined ? 0 : Math.min(0.05, Math.max(0, time - previous));
      previous = time;
      const blend = 1 - Math.exp(-dt * 3);
      for (const key of ["motion", "intensity", "density", "halloween"] as const)
        look[key] += (targetLook[key] - look[key]) * blend;
      const intensity = Math.min(1.5, Math.max(0, look.intensity));
      const density = Math.min(1, Math.max(0, look.density));
      const halloween = Math.min(1, Math.max(0, look.halloween));
      dustGeometry.setDrawRange(0, Math.round(420 * density));
      sigilMesh.count = Math.round(12 + 36 * density);
      carveMaterial.opacity = halloween;
      emberMaterial.opacity = halloween;
      ritualMaterial.opacity = 0.2 + 0.8 * halloween;
      const motion = reduced.matches ? 0 : Math.max(0, look.motion);
      clock += dt * motion;
      const signal = pulse.update(music, dt);
      response += (signal.pulse - response) * (1 - Math.exp(-dt * 4));
      const leader = music
        .filter((lane) => lane.playing && lane.level > 0.005)
        .sort((a, b) => b.level - a.level)[0];
      const sourceBpm = leader?.sourceBpm ?? leader?.bpm ?? 120;
      const beat = leader ? waveformBeat(leader.waveform, leader.time, sourceBpm) : 0;
      const laneIndex = leader ? music.indexOf(leader) * 4 : 0;
      const dance =
        suppliedDance ??
        fallbackDance.update(
          beat,
          leader?.level ?? 0,
          energy[laneIndex + 1] ?? 0,
          energy[laneIndex + 2] ?? 0,
          energy[laneIndex + 3] ?? 0,
          dt,
        );
      const danceAmount = reduced.matches ? 0 : Math.min(1.5, Math.max(0, look.motion)) * intensity;
      // Use Rekordbox phrase boundaries when supplied. Within each phrase the
      // authoritative beat grid determines progress, so pauses/seeks cannot drift.
      let journey = beat / 16;
      const phrases = leader?.rhythm?.phrases?.entries;
      if (leader && phrases?.length) {
        const index = phrases.findIndex(
          (entry) => leader.time >= entry.startSeconds && leader.time < entry.endSeconds,
        );
        if (index >= 0) {
          const entry = phrases[index]!;
          const startBeat = waveformBeat(leader.waveform, entry.startSeconds, sourceBpm);
          const endBeat = waveformBeat(leader.waveform, entry.endSeconds, sourceBpm);
          journey =
            index +
            THREE.MathUtils.clamp((beat - startBeat) / Math.max(0.001, endBeat - startBeat), 0, 1);
        }
      }
      const railPhase = ((journey % shots.length) + shots.length) % shots.length;
      cameraShot = leader ? shots[Math.floor(railPhase)]! : "still nave";
      const driveTarget = leader
        ? 0.72 + 0.28 * Math.min(1, Math.sqrt(Math.max(0, leader.level)) * 3)
        : 0;
      cameraDrive += (driveTarget - cameraDrive) * (1 - Math.exp(-dt * 1.4));
      const travelAmount = Math.min(1, Math.max(0, look.motion)) * cameraDrive;
      cameraRail.getPoint(railPhase / shots.length, desiredPosition);
      aimRail.getPoint(railPhase / shots.length, desiredAim);
      // Explicit clearance bounds also contain spline overshoot between control points.
      desiredPosition.x = THREE.MathUtils.clamp(desiredPosition.x, -2.7, 2.7);
      desiredPosition.y = THREE.MathUtils.clamp(desiredPosition.y, 2.6, 5.8);
      desiredPosition.z = THREE.MathUtils.clamp(desiredPosition.z, -4.25, 11);
      desiredPosition.lerpVectors(restPosition, desiredPosition, travelAmount);
      desiredAim.lerpVectors(restAim, desiredAim, travelAmount);
      if (reduced.matches || look.motion <= 0.001) {
        camera.position.copy(restPosition);
        aim.copy(restAim);
        cameraShot = "still nave";
      } else {
        // Critically restrained tracking softens seeks/crossfades without changing the rail tempo.
        const tracking = 1 - Math.exp(-dt * 2.8);
        camera.position.lerp(desiredPosition, tracking);
        aim.lerp(desiredAim, tracking);
      }
      camera.lookAt(aim);
      const bassTarget = leader
        ? Math.min(1, Math.max(0, energy[music.indexOf(leader) * 4 + 1] ?? 0))
        : 0;
      bass += (bassTarget - bass) * (1 - Math.exp(-dt * 4));
      const lightResponse = reduced.matches
        ? 0
        : Math.min(1, response * 0.65 + bass * 0.35) * intensity;
      warm.intensity = 85 + lightResponse * 16;
      near.intensity = 55 + lightResponse * 9;
      poolMaterial.uniforms.strength!.value =
        0.28 * (0.25 + 0.75 * intensity) + lightResponse * 0.09;
      emberMaterial.color.setRGB(1, 0.36 + lightResponse * 0.06, 0.035);
      // Beat phase comes from the music; sliders change only the pose amplitude.
      pumpkin.position.set(
        dance.sway * 0.16 * danceAmount,
        1.23 + dance.bounce * 0.24 * danceAmount,
        -8,
      );
      pumpkin.rotation.set(
        dance.nod * 0.075 * danceAmount,
        dance.twist * 0.15 * danceAmount,
        -dance.sway * 0.1 * danceAmount,
      );
      const squash = dance.kick * 0.075 * danceAmount;
      pumpkin.scale.set(1 + squash * 0.5, 1 - squash, 1 + squash * 0.5);
      ritual.position.y = 2.6 + dance.bounce * 0.1 * danceAmount;
      ritual.rotation.set(
        dance.nod * 0.035 * danceAmount,
        -dance.twist * 0.12 * danceAmount,
        dance.sway * 0.11 * danceAmount,
      );
      ritual.scale.setScalar(1 + dance.kick * 0.025 * danceAmount);
      dustMaterial.uniforms.time!.value = clock;
      composer.render(dt);
    },
    dispose() {
      composer.dispose();
      for (const resource of resources) resource.dispose();
      scene.clear();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
