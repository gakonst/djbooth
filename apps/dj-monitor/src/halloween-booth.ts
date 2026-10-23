import * as THREE from "three";
import { DEFAULT_VISUAL_LOOK, type VisualLook, type VisualTheme } from "./visual-presets.js";
import { createDancingHaunts } from "./dancing-haunts.js";

/** A procedural haunted stage. Every tunnel and its inhabitants belong to one deck. */
export async function createHalloweenBooth(host: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.domElement.className = "booth-visuals halloween-booth";
  renderer.domElement.dataset.renderer = "three-halloween";
  renderer.domElement.setAttribute("aria-hidden", "true");
  Object.assign(renderer.domElement.style, { zIndex: "1", pointerEvents: "none" });
  renderer.setClearColor(0x050008, 0);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x080010, 0.035);
  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 80);
  camera.position.z = 9;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let target: VisualLook = { ...DEFAULT_VISUAL_LOOK };
  const look = { ...target };
  const themes: VisualTheme[] = ["halloween", "eighties", "y2k", "tech-house"];
  const weights = [1, 0, 0, 0];
  const themeColors = [
    [0xe8ddbf, 0xa44e48, 0xcfc4a4],
    [0xff328e, 0x23daff, 0xb04aff],
    [0xff56cd, 0x9defff, 0xffb9eb],
    [0x9aff32, 0xe4ffef, 0x45ffbb],
  ];
  const tintColor = new THREE.Color();
  const mixColor = new THREE.Color();
  scene.add(new THREE.AmbientLight(0xb6b5e8, 1.4));
  const keyLight = new THREE.DirectionalLight(0xffffff, 3);
  keyLight.position.set(-3, 6, 8);
  scene.add(keyLight);
  const neonLight = new THREE.DirectionalLight(0xff4bbf, 2);
  neonLight.position.set(5, -2, 3);
  scene.add(neonLight);
  const orange = new THREE.MeshBasicMaterial({ color: 0xf45a08 });
  const stem = new THREE.MeshBasicMaterial({ color: 0x657b19 });
  const green = new THREE.MeshBasicMaterial({ color: 0xb5ff37 });
  const ink = new THREE.MeshBasicMaterial({ color: 0x10051d, side: THREE.DoubleSide });
  const ghostMaterial = new THREE.MeshBasicMaterial({
    color: 0xc3b6fa,
    transparent: true,
    opacity: 0.52,
    side: THREE.DoubleSide,
  });
  const sphere = new THREE.SphereGeometry(1, 16, 12);
  const torus = new THREE.TorusGeometry(1, 0.012, 5, 64);
  const eye = new THREE.ConeGeometry(0.11, 0.18, 3);
  const stemGeometry = new THREE.CylinderGeometry(0.055, 0.085, 0.23, 6);
  const ghostShape = new THREE.Shape();
  ghostShape.moveTo(-0.34, -0.3);
  ghostShape.bezierCurveTo(-0.6, 0.85, 0.6, 0.85, 0.34, -0.3);
  for (let i = 0; i <= 6; i++) ghostShape.lineTo(0.34 - (i * 0.68) / 6, -0.3 + (i % 2) * 0.15);
  const ghostGeometry = new THREE.ShapeGeometry(ghostShape);
  const batShape = new THREE.Shape();
  batShape.moveTo(0, 0.06);
  batShape.lineTo(-0.18, 0.2);
  batShape.lineTo(-0.8, 0.42);
  batShape.quadraticCurveTo(-0.65, 0, -0.48, -0.02);
  batShape.quadraticCurveTo(-0.3, 0.12, -0.22, -0.22);
  batShape.lineTo(0, -0.08);
  batShape.lineTo(0.22, -0.22);
  batShape.quadraticCurveTo(0.3, 0.12, 0.48, -0.02);
  batShape.quadraticCurveTo(0.65, 0, 0.8, 0.42);
  batShape.lineTo(0.18, 0.2);
  batShape.closePath();
  const batGeometry = new THREE.ShapeGeometry(batShape);
  const particleGeometry = new THREE.OctahedronGeometry(0.035);
  const beamGeometry = new THREE.BoxGeometry(1, 1, 1);
  const portalGeometry = new THREE.TorusGeometry(1, 0.022, 4, 4);
  const starShape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5 + Math.PI / 2;
    const r = i % 2 ? 0.24 : 0.65;
    if (i === 0) starShape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else starShape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  starShape.closePath();
  const starGeometry = new THREE.ExtrudeGeometry(starShape, {
    depth: 0.14,
    bevelEnabled: true,
    bevelThickness: 0.055,
    bevelSize: 0.045,
    bevelSegments: 1,
    steps: 1,
  });
  // Separate horizontal sunset bands leave real gaps through the glowing disc.
  const sunGeometry = new THREE.BufferGeometry();
  const sunVertices: number[] = [];
  for (let band = 0; band < 12; band++) {
    const y0 = -1 + band / 6,
      y1 = Math.min(1, y0 + 0.115);
    for (let s = 0; s < 16; s++) {
      const a = y0 + ((y1 - y0) * s) / 16,
        b = y0 + ((y1 - y0) * (s + 1)) / 16;
      const x = Math.sqrt(Math.max(0, 1 - a * a)),
        z = Math.sqrt(Math.max(0, 1 - b * b));
      sunVertices.push(-x, a, 0, x, a, 0, -z, b, 0, x, a, 0, z, b, 0, -z, b, 0);
    }
  }
  sunGeometry.setAttribute("position", new THREE.Float32BufferAttribute(sunVertices, 3));
  const dummy = new THREE.Object3D();
  const palettes = [0xe8ddbf, 0xa44e48, 0xcfc4a4];
  const lanes = palettes.map((tint, lane) => {
    const root = new THREE.Group();
    scene.add(root);
    const retroMaterial = new THREE.MeshBasicMaterial({
      color: 0xff38af,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sunMaterial = new THREE.MeshBasicMaterial({
      color: 0xff862c,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const chromeMaterial = new THREE.MeshPhongMaterial({
      color: 0xd8dfff,
      specular: 0xffffff,
      shininess: 100,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const popMaterial = new THREE.MeshBasicMaterial({
      color: 0xff4dbf,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const techMaterial = new THREE.MeshBasicMaterial({
      color: 0x9aff32,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const grid = new THREE.InstancedMesh(beamGeometry, retroMaterial, 44);
    const sun = new THREE.Mesh(sunGeometry, sunMaterial);
    sun.position.set(0, 2.4, -9);
    sun.scale.setScalar(2.8);
    const stars = new THREE.InstancedMesh(starGeometry, chromeMaterial, 20);
    const disco = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 1), chromeMaterial);
    disco.position.set(0, 2.4, -3);
    const popOrbits = new THREE.InstancedMesh(torus, popMaterial, 10);
    const portals = new THREE.InstancedMesh(portalGeometry, techMaterial, 18);
    const lasers = new THREE.InstancedMesh(beamGeometry, techMaterial, 24);
    root.add(grid, sun, stars, disco, popOrbits, portals, lasers);
    for (const mesh of [grid, stars, popOrbits, portals, lasers]) mesh.frustumCulled = false;
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: tint,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const rings = new THREE.InstancedMesh(torus, ringMaterial, 22);
    root.add(rings);
    const particles = new THREE.InstancedMesh(
      particleGeometry,
      new THREE.MeshBasicMaterial({
        color: tint,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      72,
    );
    root.add(particles);
    const ribbonGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(256 * 2 * 3);
    const colors = new Float32Array(256 * 2 * 4);
    const indices: number[] = [];
    for (let i = 0; i < 255; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    ribbonGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
    );
    ribbonGeometry.setAttribute(
      "signal",
      new THREE.BufferAttribute(colors, 4).setUsage(THREE.DynamicDrawUsage),
    );
    ribbonGeometry.setIndex(indices);
    const ribbonMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader:
        "attribute vec4 signal; varying vec4 vSignal; void main(){vSignal=signal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
      fragmentShader:
        "varying vec4 vSignal; void main(){gl_FragColor=vec4(vSignal.rgb,vSignal.a);}",
    });
    const ribbon = new THREE.Mesh(ribbonGeometry, ribbonMaterial);
    ribbon.frustumCulled = false;
    root.add(ribbon);
    const pumpkins: THREE.Group[] = [];
    const ghosts: THREE.Group[] = [];
    const bats: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const pumpkin = new THREE.Group();
      for (let rib = 0; rib < 7; rib++) {
        const lobe = new THREE.Mesh(sphere, orange);
        const a = (rib / 7) * Math.PI * 2;
        lobe.scale.set(0.19, 0.29, 0.2);
        lobe.position.set(Math.cos(a) * 0.15, 0, Math.sin(a) * 0.15);
        pumpkin.add(lobe);
      }
      const stalk = new THREE.Mesh(stemGeometry, stem);
      stalk.position.y = 0.34;
      stalk.rotation.z = -0.2;
      pumpkin.add(stalk);
      for (const x of [-0.13, 0.13]) {
        const face = new THREE.Mesh(eye, green);
        face.position.set(x, 0.08, 0.31);
        pumpkin.add(face);
      }
      const grin = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.025, 3, 12, Math.PI), green);
      grin.rotation.z = Math.PI;
      grin.position.set(0, -0.04, 0.32);
      pumpkin.add(grin);
      root.add(pumpkin);
      pumpkins.push(pumpkin);
      const ghost = new THREE.Group();
      ghost.add(new THREE.Mesh(ghostGeometry, ghostMaterial));
      for (const x of [-0.1, 0.1]) {
        const socket = new THREE.Mesh(sphere, ink);
        socket.scale.set(0.045, 0.075, 0.02);
        socket.position.set(x, 0.23, 0.03);
        ghost.add(socket);
      }
      root.add(ghost);
      ghosts.push(ghost);
    }
    for (let i = 0; i < 12; i++) {
      const bat = new THREE.Mesh(batGeometry, ink);
      root.add(bat);
      bats.push(bat);
    }
    return {
      root,
      rings,
      ringMaterial,
      particles,
      ribbonGeometry,
      positions,
      colors,
      pumpkins,
      ghosts,
      bats,
      previousBeat: -1,
      burst: 0,
      level: 0,
      lane,
      grid,
      sun,
      stars,
      disco,
      popOrbits,
      portals,
      lasers,
      retroMaterial,
      sunMaterial,
      chromeMaterial,
      popMaterial,
      techMaterial,
    };
  });
  // Pixel-space stage remains outside the hardware even during perspective cuts.
  const stage = new THREE.Scene();
  const stageCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  stageCamera.position.z = 500;
  stage.add(new THREE.AmbientLight(0xffefd9, 1.5));
  const mirrorLight = new THREE.DirectionalLight(0xffffff, 4);
  mirrorLight.position.set(-200, 300, 400);
  stage.add(mirrorLight);
  const mirrorFill = new THREE.DirectionalLight(0xb5c8ff, 2);
  mirrorFill.position.set(300, -100, 250);
  stage.add(mirrorFill);
  const ball = new THREE.Group();
  ball.name = "global-mirror-disco-ball";
  const mirrorMaterial = new THREE.MeshPhongMaterial({
    color: 0xcbd5de,
    specular: 0xffffff,
    shininess: 110,
    flatShading: true,
  });
  const ballCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.98, 2), mirrorMaterial);
  const tiles = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.15, 0.15), mirrorMaterial, 320);
  const normal = new THREE.Vector3();
  const forward = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < 320; i++) {
    const y = 1 - (i + 0.5) / 160;
    const r = Math.sqrt(1 - y * y),
      a = i * 2.399963;
    normal.set(Math.cos(a) * r, y, Math.sin(a) * r);
    dummy.position.copy(normal);
    dummy.quaternion.setFromUnitVectors(forward, normal);
    dummy.scale.setScalar(1);
    dummy.updateMatrix();
    tiles.setMatrixAt(i, dummy.matrix);
    tiles.setColorAt(i, new THREE.Color().setHSL(0.58, 0.03, 0.3 + (i % 7) * 0.1));
  }
  ball.add(ballCore, tiles);
  stage.add(ball);
  const cord = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({ color: 0xcfc6b1 }),
  );
  stage.add(cord);
  const poolMaterial = new THREE.MeshBasicMaterial({
    color: 0xffebcd,
    transparent: true,
    opacity: 0.25,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const pools = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 16), poolMaterial, 28);
  pools.frustumCulled = false;
  stage.add(pools);
  const coneMaterial = new THREE.MeshBasicMaterial({
    color: 0xe8ddbf,
    transparent: true,
    opacity: 0.035,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const cones = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 12, 1, true), coneMaterial, 6);
  cones.frustumCulled = false;
  stage.add(cones);
  const haunts = [createDancingHaunts(), createDancingHaunts()];
  const hauntMaterials: { material: THREE.Material; opacity: number }[] = [];
  for (const haunt of haunts) {
    stage.add(haunt.group);
    const seen = new Set<THREE.Material>();
    haunt.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          if (!seen.has(material)) {
            seen.add(material);
            hauntMaterials.push({ material, opacity: material.opacity });
            material.transparent = true;
          }
        }
      }
    });
  }
  // A clear, legible theme emblem in the upper safe band, separate from the tunnels.
  const hero = new THREE.Group();
  stage.add(hero);
  const heroSunMaterial = new THREE.MeshBasicMaterial({
    color: 0xff745b,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  });
  const heroSun = new THREE.Mesh(sunGeometry, heroSunMaterial);
  const heroStarMaterial = new THREE.MeshPhongMaterial({
    color: 0xffafe1,
    specular: 0xffffff,
    shininess: 100,
    transparent: true,
    opacity: 0,
  });
  const heroStar = new THREE.Mesh(starGeometry, heroStarMaterial);
  const heroPortalMaterial = new THREE.MeshBasicMaterial({
    color: 0xbaff69,
    transparent: true,
    opacity: 0,
  });
  const heroPortal = new THREE.Mesh(portalGeometry, heroPortalMaterial);
  hero.add(heroSun, heroStar, heroPortal);
  const previousVisibility = host.style.visibility;
  host.after(renderer.domElement);
  host.style.visibility = "hidden";
  let disposed = false;
  let width = 0,
    height = 0,
    previousTime = 0;
  let sceneTime = 0;
  return {
    setLook(next: VisualLook) {
      const bounded = (value: number, min: number, max: number, fallback: number) =>
        Number.isFinite(value) ? THREE.MathUtils.clamp(value, min, max) : fallback;
      target = {
        theme: themes.includes(next.theme) ? next.theme : target.theme,
        intensity: bounded(next.intensity, 0, 2, target.intensity),
        motion: bounded(next.motion, 0, 2, target.motion),
        density: bounded(next.density, 0.1, 1, target.density),
        halloween: bounded(next.halloween, 0, 1, target.halloween),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const haunt of haunts) {
        stage.remove(haunt.group);
        haunt.dispose();
      }
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      const collect = (object: THREE.Object3D) => {
        if (object instanceof THREE.Mesh) {
          geometries.add(object.geometry);
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material])
            materials.add(material);
          if (object instanceof THREE.InstancedMesh) object.dispose();
        }
      };
      scene.traverse(collect);
      stage.traverse(collect);
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      host.style.visibility = previousVisibility;
    },
    draw(
      time: number,
      rgba: Uint8Array,
      energy: Float32Array,
      motion: Float32Array,
      origins: Float32Array,
    ) {
      if (disposed) return;
      const w = Math.max(1, innerWidth),
        h = Math.max(1, innerHeight);
      if (w !== width || h !== height) {
        width = w;
        height = h;
        renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        stageCamera.left = -w / 2;
        stageCamera.right = w / 2;
        stageCamera.top = h / 2;
        stageCamera.bottom = -h / 2;
        stageCamera.updateProjectionMatrix();
      }
      const dt = Math.min(0.05, Math.max(0, time - previousTime));
      previousTime = time;
      const blend = 1 - Math.exp(-dt * 2);
      for (const key of ["intensity", "motion", "density", "halloween"] as const)
        look[key] += (target[key] - look[key]) * blend;
      themes.forEach((theme, i) => {
        weights[i] = weights[i]! + ((target.theme === theme ? 1 : 0) - weights[i]!) * blend;
      });
      const damping = (reduced.matches ? 0.08 : 1) * look.motion;
      sceneTime += dt * damping;
      const t = sceneTime;
      const intensity = look.intensity;
      for (const material of [orange, stem, green, ink, ghostMaterial]) {
        material.transparent = true;
        material.depthWrite = false;
        material.opacity =
          look.halloween * Math.min(1, intensity) * (material === ghostMaterial ? 0.52 : 1);
      }
      const halfHeight = Math.tan(THREE.MathUtils.degToRad(26)) * 9;
      let shake = 0;
      for (const lane of lanes) {
        const e = lane.lane * 4;
        lane.root.visible = rgba.length >= (lane.lane + 1) * 1024;
        if (!lane.root.visible) continue;
        const level = Math.min(1, Math.sqrt(Math.max(0, energy[e] ?? 0)) * 1.7);
        lane.level += (level - lane.level) * (1 - Math.exp(-dt * 12));
        const low = Math.min(1, Math.max(0, energy[e + 1] ?? 0));
        const mid = Math.min(1, Math.max(0, energy[e + 2] ?? 0));
        const high = Math.min(1, Math.max(0, energy[e + 3] ?? 0));
        const phase = motion[e + 3] ?? 0;
        const beat = Math.floor(phase);
        if (beat !== lane.previousBeat && lane.previousBeat >= 0 && level > 0.025) lane.burst = 1;
        lane.previousBeat = beat;
        lane.burst *= Math.exp(-dt * 4.5);
        if (level <= 0.025) lane.burst = 0;
        const pulse = lane.burst * Math.min(1.5, damping) * intensity;
        shake = Math.min(1, Math.max(shake, pulse * low));
        lane.root.position.set(
          (origins[lane.lane * 2] ?? (lane.lane - 1) * 0.6) * halfHeight * camera.aspect,
          (origins[lane.lane * 2 + 1] ?? 0) * halfHeight,
          1.5,
        );
        tintColor.setRGB(0, 0, 0);
        themes.forEach((_, i) => {
          mixColor.setHex(themeColors[i]![lane.lane]!).multiplyScalar(weights[i]!);
          tintColor.add(mixColor);
        });
        lane.ringMaterial.color.copy(tintColor);
        lane.particles.material.color.copy(tintColor);
        lane.ringMaterial.opacity =
          (0.035 + lane.level * 0.5) *
          intensity *
          (weights[0]! + weights[1]! * 0.45 + weights[2]! * 0.15);
        lane.rings.count = Math.max(2, Math.round(22 * look.density));
        lane.particles.count = Math.round(72 * look.density);
        const retro = weights[1]! * intensity;
        const pop = weights[2]! * intensity;
        const tech = weights[3]! * intensity;
        lane.retroMaterial.opacity = retro * (0.15 + lane.level * 0.45);
        lane.sunMaterial.opacity = retro * 0.6;
        lane.chromeMaterial.opacity = Math.min(1, pop * 0.85);
        lane.popMaterial.opacity = pop * (0.2 + lane.level * 0.5);
        lane.techMaterial.opacity = tech * (0.12 + lane.level * 0.55);
        lane.grid.visible = lane.sun.visible = retro > 0.002;
        lane.stars.visible = lane.disco.visible = lane.popOrbits.visible = pop > 0.002;
        lane.portals.visible = lane.lasers.visible = tech > 0.002;
        lane.stars.count = Math.max(2, Math.round(20 * look.density));
        lane.popOrbits.count = Math.max(2, Math.round(10 * look.density));
        lane.portals.count = Math.max(2, Math.round(18 * look.density));
        lane.lasers.count = Math.max(2, Math.round(24 * look.density));
        lane.grid.count = Math.max(4, Math.round(22 * look.density) * 2);
        for (let i = 0; i < lane.grid.count; i++) {
          const cross = i % 2 === 0,
            n = Math.floor(i / 2);
          dummy.position.set(cross ? 0 : (n - 11) * 0.6, -2.6, cross ? -((n + t * 0.7) % 22) : -10);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(cross ? 14 : 0.014, 0.014, cross ? 0.014 : 24);
          dummy.updateMatrix();
          lane.grid.setMatrixAt(i, dummy.matrix);
        }
        lane.grid.instanceMatrix.needsUpdate = true;
        lane.sun.scale.setScalar(2.8 + low * lane.level * intensity * 0.3);
        lane.disco.rotation.set(t * 0.23, t * 0.37, t * 0.13);
        lane.disco.scale.setScalar(1 + pulse * 0.15);
        for (let i = 0; i < lane.stars.count; i++) {
          const a = i * 2.399 + lane.lane + t * 0.12;
          const r = 3.2 + (i % 4) * 0.8;
          dummy.position.set(Math.cos(a) * r, Math.sin(a) * r, -1 - (i % 5) * 1.7);
          dummy.rotation.set(t * 0.6 + i, t * 0.4, a);
          dummy.scale.setScalar((0.35 + (i % 3) * 0.13) * (1 + pulse * 0.2));
          dummy.updateMatrix();
          lane.stars.setMatrixAt(i, dummy.matrix);
        }
        lane.stars.instanceMatrix.needsUpdate = true;
        for (let i = 0; i < lane.popOrbits.count; i++) {
          dummy.position.set(0, 0, -i * 1.3);
          dummy.rotation.set(0.5 + Math.sin(t * 0.2 + i) * 0.4, i * 0.3, t * 0.2);
          dummy.scale.set(3.8 + mid * intensity, 3.1 + i * 0.16, 1);
          dummy.updateMatrix();
          lane.popOrbits.setMatrixAt(i, dummy.matrix);
        }
        lane.popOrbits.instanceMatrix.needsUpdate = true;
        for (let i = 0; i < lane.portals.count; i++) {
          const travel = (i / 18 + t * (0.035 + lane.level * 0.025)) % 1;
          dummy.position.set(0, 0, -travel * 25);
          dummy.rotation.set(
            0,
            0,
            Math.PI / 4 + (lane.lane * Math.PI) / 8 + Math.sin(t * 0.15) * 0.12,
          );
          dummy.scale.set(3.4 + travel * 5 + pulse * 0.4, 3.4 + travel * 5, 1);
          dummy.updateMatrix();
          lane.portals.setMatrixAt(i, dummy.matrix);
        }
        lane.portals.instanceMatrix.needsUpdate = true;
        for (let i = 0; i < lane.lasers.count; i++) {
          const a = (i / 24) * Math.PI * 2 + lane.lane;
          dummy.position.set(Math.cos(a) * 4.8, Math.sin(a) * 4.8, -5);
          dummy.rotation.set(Math.sin(t * 0.3 + a) * 0.12, Math.cos(t * 0.23 + a) * 0.12, a);
          dummy.scale.set(0.008 + high * lane.level * intensity * 0.025, 0.012, 20);
          dummy.updateMatrix();
          lane.lasers.setMatrixAt(i, dummy.matrix);
        }
        lane.lasers.instanceMatrix.needsUpdate = true;
        for (let i = 0; i < 22; i++) {
          const sample = (lane.lane * 256 + Math.round((i / 21) * 255)) * 4;
          const amplitude = (rgba[sample + 3] ?? 0) / 255;
          const travel = (i / 22 + t * (0.018 + lane.level * 0.025)) % 1;
          dummy.position.set(
            Math.sin(i * 0.3 + t * 0.12) * 0.25,
            Math.cos(i * 0.4) * 0.18,
            -travel * 24,
          );
          dummy.rotation.set(
            0.12 * Math.sin(t * 0.1),
            0.1 * Math.cos(i),
            i * 0.16 + t * 0.04 + (motion[e] ?? 0) * 0.1 + (motion[e + 1] ?? 0) * 0.15,
          );
          const radius = (2.8 + travel * 6) * (1 + pulse * 0.22 + amplitude * lane.level * 0.2);
          dummy.scale.set(radius * (1 + (lane.lane === 0 ? amplitude * 0.35 : 0)), radius, 1);
          dummy.updateMatrix();
          lane.rings.setMatrixAt(i, dummy.matrix);
        }
        lane.rings.instanceMatrix.needsUpdate = true;
        for (let i = 0; i < 256; i++) {
          const u = i / 255,
            offset = (lane.lane * 256 + i) * 4;
          const amplitude = (rgba[offset + 3] ?? 0) / 255;
          const angle = u * Math.PI * (lane.lane === 1 ? 9 : 5) + t * 0.16 + lane.lane * 2.1;
          const radius =
            0.45 +
            u * 6.5 +
            amplitude * (0.35 + mid + Math.min(1, Math.abs(motion[e + 2] ?? 0)) * 0.3);
          for (let side = 0; side < 2; side++) {
            const p = (i * 2 + side) * 3,
              c = (i * 2 + side) * 4;
            const r = radius + (side ? 1 : -1) * (0.012 + amplitude * 0.1);
            // Independent silhouettes: serpentine ribs, a twisting vortex,
            // and angular portals. All retain their own waveform envelope.
            const square = Math.max(Math.abs(Math.cos(angle)), Math.abs(Math.sin(angle)));
            lane.positions[p] =
              lane.lane === 0
                ? Math.sin(angle) * r * 0.55
                : (Math.cos(angle) * r) / (lane.lane === 2 ? square : 1);
            lane.positions[p + 1] =
              lane.lane === 0
                ? (u - 0.5) * 13 + (side ? 1 : -1) * amplitude * 0.15
                : (Math.sin(angle) * r) / (lane.lane === 2 ? square : 1);
            lane.positions[p + 2] = -u * 4 + Math.sin(u * 18 + t) * amplitude * damping;
            for (let channel = 0; channel < 3; channel++)
              lane.colors[c + channel] = (rgba[offset + channel] ?? 0) / 255;
            lane.colors[c + 3] = amplitude * lane.level * intensity;
          }
        }
        lane.ribbonGeometry.attributes.position!.needsUpdate = true;
        lane.ribbonGeometry.attributes.signal!.needsUpdate = true;
        lane.particles.material.opacity = Math.min(0.9, pulse * 0.75);
        for (let i = 0; i < 72; i++) {
          const a = i * 2.39996,
            r = 2 + (1 - lane.burst) * 5;
          dummy.position.set(Math.cos(a) * r, Math.sin(a) * r, -1 - (i % 7) * 0.35);
          dummy.rotation.set(a, t, a);
          dummy.scale.setScalar(0.6 + high * 2);
          dummy.updateMatrix();
          lane.particles.setMatrixAt(i, dummy.matrix);
        }
        lane.particles.instanceMatrix.needsUpdate = true;
        lane.pumpkins.forEach((pumpkin, i) => {
          pumpkin.visible = false;
          const a = (i * Math.PI) / 2 + 0.7;
          pumpkin.position.set(
            Math.cos(a) * 4.8,
            Math.sin(a) * 4.8 + Math.sin(t + i) * 0.08,
            -i * 1.4,
          );
          pumpkin.rotation.z = Math.sin(t * 0.5 + i) * 0.13;
          pumpkin.scale.setScalar(1 + pulse * 0.22 + low * 0.1);
        });
        lane.ghosts.forEach((ghost, i) => {
          ghost.visible = false;
          const a = (i * Math.PI) / 2 + t * 0.06 + 1.5;
          ghost.position.set(Math.cos(a) * 3.2, Math.sin(a) * 2.4 + Math.sin(t + i) * 0.2, -2 - i);
          ghost.rotation.z = Math.sin(t + i) * 0.18;
          ghost.scale.setScalar(0.8 + mid * 0.3);
        });
        lane.bats.forEach((bat, i) => {
          bat.visible = false;
          const a = i * 2.4 + t * (0.08 + lane.level * 0.08);
          bat.position.set(Math.cos(a) * (2.4 + (i % 3)), Math.sin(a) * 3, -1 - i * 0.6);
          bat.rotation.z = Math.sin(a) * 0.4;
          bat.scale.set(0.3 + Math.abs(Math.sin(t * 5 + i)) * 0.22 * damping, 0.4 + high * 0.1, 1);
        });
      }
      camera.position.x = Math.sin(t * 29) * shake * 0.22 * damping;
      camera.position.y = Math.cos(t * 23) * shake * 0.16 * damping;
      camera.position.z = 9 - shake * 1.1 * damping;
      camera.rotation.z = (Math.sin(t * 0.13) * 0.015 + Math.sin(t * 5) * shake * 0.045) * damping;
      const hardware = Array.from(
        document.querySelectorAll<HTMLElement>(".booth-grid > .cdj3000, .booth-grid > .djma9"),
      )
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const top = hardware.length
        ? Math.max(0, Math.min(...hardware.map((rect) => rect.top)) - 12)
        : h * 0.36;
      const bottom = hardware.length
        ? Math.min(h, Math.max(...hardware.map((rect) => rect.bottom)) + 12)
        : h * 0.66;
      const left = hardware.length
        ? Math.max(0, Math.min(...hardware.map((rect) => rect.left)) - 12)
        : w * 0.1;
      const right = hardware.length
        ? Math.min(w, Math.max(...hardware.map((rect) => rect.right)) + 12)
        : w * 0.9;
      const bands = [
        { x: 12, y: 12, w: Math.max(0, w * 0.28 - 24), h: Math.max(0, top - 24) },
        { x: w * 0.72, y: 12, w: Math.max(0, w * 0.28 - 12), h: Math.max(0, top - 24) },
        { x: 12, y: bottom, w: Math.max(0, w / 2 - 24), h: Math.max(0, h - bottom - 12) },
        { x: w / 2 + 12, y: bottom, w: Math.max(0, w / 2 - 24), h: Math.max(0, h - bottom - 12) },
        { x: 12, y: top + 12, w: Math.max(0, left - 24), h: Math.max(0, bottom - top - 24) },
        {
          x: right,
          y: top + 12,
          w: Math.max(0, w - right - 12),
          h: Math.max(0, bottom - top - 24),
        },
      ];
      const ranked = [...bands].sort((a, b) => Math.min(b.w, b.h) - Math.min(a.w, a.h));
      let activeLane = 0;
      for (let i = 1; i < lanes.length; i++)
        if (lanes[i]!.level > lanes[activeLane]!.level) activeLane = i;
      const live = lanes[activeLane]!;
      for (const { material, opacity } of hauntMaterials)
        material.opacity = opacity * look.halloween * Math.min(1, intensity);
      haunts.forEach((haunt, i) => {
        const band = ranked[i]!;
        const scale = Math.min(band.w, band.h) / 3.8;
        haunt.group.visible = scale > 7 && look.halloween > 0.005;
        haunt.group.position.set(band.x + band.w / 2 - w / 2, h / 2 - band.y - band.h / 2, 10);
        haunt.group.scale.setScalar(scale);
        haunt.update(t + i * 0.3, live.burst, live.level * Math.min(1.5, intensity), damping);
      });
      // The mixer gets a real tiled mirrorball in the upper band in every look.
      const ballRadius = Math.max(5, Math.min(45, top * 0.25, w * 0.035));
      const ballY = Math.max(ballRadius + 4, top * 0.48);
      const mixer = document
        .querySelector<HTMLElement>(".booth-grid > .djma9")
        ?.getBoundingClientRect();
      const ballX = mixer ? mixer.left + mixer.width / 2 : w / 2;
      ball.position.set(ballX - w / 2, h / 2 - ballY, 20);
      ball.scale.setScalar(ballRadius);
      ball.rotation.set(0.16, t * 0.45, Math.sin(t * 0.2) * 0.06);
      cord.position.set(ball.position.x, h / 2 - (ballY - ballRadius) / 2, 19);
      cord.scale.set(1, Math.max(0, ballY - ballRadius), 1);
      mirrorLight.position.x = Math.sin(t * 0.4) * 300;
      mirrorFill.color.copy(tintColor).lerp(new THREE.Color(0xffffff), 0.65);
      poolMaterial.color.copy(tintColor).lerp(new THREE.Color(0xfff1d9), 0.65);
      poolMaterial.opacity = 0.12 + live.level * intensity * 0.25;
      pools.count = Math.round(12 + look.density * 16);
      for (let i = 0; i < pools.count; i++) {
        const band = bands[i % bands.length]!;
        const x = band.x + band.w * (0.5 + Math.sin(t * 0.4 + i * 2.4) * 0.38);
        const y = band.y + band.h * (0.5 + Math.cos(t * 0.3 + i * 1.8) * 0.34);
        const radius = Math.min(18, band.w * 0.12, band.h * 0.12);
        dummy.position.set(x - w / 2, h / 2 - y, 1);
        dummy.rotation.set(0, 0, t * 0.2 + i);
        dummy.scale.set(Math.max(0, radius), Math.max(0, radius * 0.45), 1);
        dummy.updateMatrix();
        pools.setMatrixAt(i, dummy.matrix);
      }
      pools.instanceMatrix.needsUpdate = true;
      // Soft, bounded beams stay in the upper band instead of washing out deck text.
      for (let i = 0; i < 6; i++) {
        const endX = w * (0.1 + i * 0.16) + Math.sin(t * 0.3 + i) * w * 0.025;
        const endY = Math.max(ballY, top - 10);
        const dx = endX - ballX,
          dy = -(endY - ballY);
        dummy.position.set(ball.position.x + dx / 2, ball.position.y + dy / 2, 0);
        dummy.rotation.set(0, 0, Math.atan2(-dx, dy));
        dummy.scale.set(Math.min(24, top * 0.15), Math.hypot(dx, dy), 1);
        dummy.updateMatrix();
        cones.setMatrixAt(i, dummy.matrix);
      }
      cones.instanceMatrix.needsUpdate = true;
      hero.position.set(
        THREE.MathUtils.clamp(ballX - w * 0.17, w * 0.36, w * 0.5) - w / 2,
        h / 2 - top * 0.5,
        5,
      );
      hero.scale.setScalar(Math.max(1, Math.min(top * 0.3, w * 0.07)));
      heroSunMaterial.opacity = weights[1]! * Math.min(1, intensity);
      heroStarMaterial.opacity = weights[2]! * Math.min(1, intensity);
      heroPortalMaterial.opacity = weights[3]! * Math.min(1, intensity);
      heroStar.rotation.set(t * 0.3, t * 0.4, 0);
      heroPortal.rotation.z = Math.PI / 4 + Math.sin(t * 0.2) * 0.2;
      renderer.domElement.dataset.theme = target.theme;
      renderer.domElement.dataset.layout = "hardware-safe-bands";
      renderer.domElement.dataset.discoBall = "always";
      renderer.domElement.dataset.safeTop = String(Math.round(top));
      renderer.domElement.dataset.safeBottom = String(Math.round(h - bottom));
      renderer.domElement.dataset.visibleDancers = String(
        haunts.filter((haunt) => haunt.group.visible).length,
      );
      renderer.render(scene, camera);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(stage, stageCamera);
      renderer.autoClear = true;
    },
  };
}
