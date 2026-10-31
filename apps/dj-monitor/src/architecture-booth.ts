import { createDanceMotion, type MusicDance } from "./music-dance.js";
import * as THREE from "three";
import { waveformAccent } from "./waveform-signal.js";

/** Audio builds the room itself: each deck owns interleaved structural columns. */
export function createArchitectureBooth(scene: THREE.Scene) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const danceMotion = createDanceMotion();
  let suppliedDance: MusicDance | undefined;
  let danceAmount = 1;
  let dancePrevious: number | undefined;
  let danceLeader = 0;
  const readDance = (time: number, energy: Float32Array, motion: Float32Array) => {
    for (let lane = 0; lane < 3; lane++)
      if ((energy[lane * 4] ?? 0) > (energy[danceLeader * 4] ?? 0) * 1.25 + 0.01)
        danceLeader = lane;
    const e = danceLeader * 4;
    const dt = dancePrevious === undefined ? 0 : time - dancePrevious;
    dancePrevious = time;
    const fallback = danceMotion.update(
      motion[e + 3] ?? 0,
      energy[e] ?? 0,
      energy[e + 1] ?? 0,
      energy[e + 2] ?? 0,
      energy[e + 3] ?? 0,
      dt,
    );
    return suppliedDance ?? fallback;
  };
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    metalness: 0.32,
    roughness: 0.56,
    dithering: true,
    emissive: 0x28182d,
    emissiveIntensity: 0.35,
  });
  const edgeMaterial = new THREE.MeshBasicMaterial();
  const rows = 28,
    columns = 8,
    count = rows * columns * 4;
  const lanes = Array.from({ length: 3 }, () => {
    const body = new THREE.InstancedMesh(geometry, bodyMaterial, count);
    const edge = new THREE.InstancedMesh(geometry, edgeMaterial, count);
    body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    edge.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    body.frustumCulled = edge.frustumCulled = false;
    group.add(body, edge);
    return { body, edge };
  });
  const previousFog = scene.fog;
  scene.fog = new THREE.FogExp2(0x10091c, 0.045);
  const ambient = new THREE.AmbientLight(0xc2aecf, 1.4);
  const key = new THREE.DirectionalLight(0xffc18f, 4);
  key.position.set(-3, 5, 4);
  const fill = new THREE.DirectionalLight(0xa99aff, 2.8);
  fill.position.set(4, -3, 2);
  group.add(ambient, key, fill);
  // Repeated pointed vaults supply a readable architectural silhouette behind the signal.
  const vaultPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-3.4, -1.9, 0),
    new THREE.Vector3(-3.4, 0.5, 0),
    new THREE.Vector3(-2.3, 1.7, 0),
    new THREE.Vector3(0, 2.8, 0),
    new THREE.Vector3(2.3, 1.7, 0),
    new THREE.Vector3(3.4, 0.5, 0),
    new THREE.Vector3(3.4, -1.9, 0),
  ]);
  const vaultGeometry = new THREE.TubeGeometry(vaultPath, 40, 0.07, 8, false);
  const vaultMaterial = new THREE.MeshStandardMaterial({
    color: 0xbd9364,
    metalness: 0.45,
    roughness: 0.4,
    emissive: 0x633419,
    emissiveIntensity: 0.35,
  });
  const vaults = new THREE.InstancedMesh(vaultGeometry, vaultMaterial, 14);
  const vaultTransform = new THREE.Object3D();
  for (let i = 0; i < 14; i++) {
    vaultTransform.position.z = 1 - i * 1.36;
    vaultTransform.updateMatrix();
    vaults.setMatrixAt(i, vaultTransform.matrix);
  }
  group.add(vaults);
  // A stone nave with repeated carved pilasters and suspended amber lanterns.
  // All fixtures share geometry; the entire architectural dressing adds five draws.
  const dressing = new THREE.Group();
  const fixtureMeshes: THREE.InstancedMesh[] = [];
  const fixtureGeometries = new Set<THREE.BufferGeometry>();
  const fixtureMaterials = new Set<THREE.Material>();
  const stone = new THREE.MeshStandardMaterial({
    color: 0x776983,
    roughness: 0.82,
    metalness: 0.12,
  });
  const lanternMaterial = new THREE.MeshBasicMaterial({ color: 0xffb666 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x493541, metalness: 0.6, roughness: 0.45 });
  function fixtures(geometry: THREE.BufferGeometry, material: THREE.Material, count: number) {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    fixtureMeshes.push(mesh);
    fixtureGeometries.add(geometry);
    fixtureMaterials.add(material);
    dressing.add(mesh);
    return mesh;
  }
  const pillars = fixtures(new THREE.CylinderGeometry(0.11, 0.17, 3.4, 8), stone, 28);
  const capitals = fixtures(new THREE.BoxGeometry(0.42, 0.15, 0.4), vaultMaterial, 56);
  const lamps = fixtures(new THREE.OctahedronGeometry(0.13, 0), lanternMaterial, 28);
  const cages = fixtures(new THREE.TorusGeometry(0.16, 0.018, 5, 8), iron, 56);
  const chains = fixtures(new THREE.CylinderGeometry(0.012, 0.012, 0.55, 5), iron, 28);
  for (let i = 0; i < 14; i++)
    for (let side = 0; side < 2; side++) {
      const index = i * 2 + side;
      const sign = side ? 1 : -1;
      const z = 1 - i * 1.36;
      vaultTransform.rotation.set(0, 0, 0);
      vaultTransform.position.set(sign * 3.1, -0.15, z);
      vaultTransform.updateMatrix();
      pillars.setMatrixAt(index, vaultTransform.matrix);
      for (let end = 0; end < 2; end++) {
        vaultTransform.position.y = end ? 1.5 : -1.75;
        vaultTransform.updateMatrix();
        capitals.setMatrixAt(index * 2 + end, vaultTransform.matrix);
      }
      vaultTransform.position.set(sign * 2.85, 0.95, z);
      vaultTransform.updateMatrix();
      lamps.setMatrixAt(index, vaultTransform.matrix);
      for (let ring = 0; ring < 2; ring++) {
        vaultTransform.rotation.y = (ring * Math.PI) / 2;
        vaultTransform.updateMatrix();
        cages.setMatrixAt(index * 2 + ring, vaultTransform.matrix);
      }
      vaultTransform.rotation.set(0, 0, 0);
      vaultTransform.position.y = 1.35;
      vaultTransform.updateMatrix();
      chains.setMatrixAt(index, vaultTransform.matrix);
    }
  group.add(dressing);
  const stonePalette = [
    new THREE.Color(0xb59677),
    new THREE.Color(0x8c7caa),
    new THREE.Color(0x799f94),
  ];
  const signalColor = new THREE.Color();
  scene.add(group);
  const object = new THREE.Object3D(),
    color = new THREE.Color();
  return {
    setLook(value: { motion: number }) {
      danceAmount = Number.isFinite(value.motion) ? Math.max(0, Math.min(2, value.motion)) : 1;
    },
    setDance(value: MusicDance) {
      suppliedDance = value;
    },
    dispose() {
      scene.remove(group);
      scene.fog = previousFog;
      lanes.forEach(({ body, edge }) => {
        body.dispose();
        edge.dispose();
      });
      fixtureMeshes.forEach((mesh) => mesh.dispose());
      fixtureGeometries.forEach((item) => item.dispose());
      fixtureMaterials.forEach((item) => {
        if (item !== vaultMaterial) item.dispose();
      });
      vaults.dispose();
      vaultGeometry.dispose();
      vaultMaterial.dispose();
      geometry.dispose();
      bodyMaterial.dispose();
      edgeMaterial.dispose();
    },
    draw(
      time: number,
      rgba: Uint8Array,
      energy: Float32Array,
      motion: Float32Array,
      aspect: number,
    ) {
      const dance = readDance(time, energy, motion);
      const groove = reduced.matches ? 0 : danceAmount;
      group.rotation.z = 0;
      vaults.rotation.z = dance.sway * groove * 0.012;
      dressing.position.y = dance.bounce * groove * 0.025;
      const width = Math.max(0.6, Math.sqrt(aspect));
      vaults.scale.x = dressing.scale.x = width;
      vaultMaterial.emissiveIntensity = 0.65 + Math.min(1, Math.max(0, energy[0] ?? 0)) * 0.45;
      for (let lane = 0; lane < 3; lane++) {
        const { body, edge } = lanes[lane]!;
        const gain = Math.min(1, Math.sqrt(Math.max(0, energy[lane * 4] ?? 0)) * 1.7);
        const beat = motion[lane * 4 + 3] ?? 0;
        for (let row = 0; row < rows; row++)
          for (let column = 0; column < columns; column++) {
            const sample = Math.round((row / (rows - 1)) * 255);
            const offset = (lane * 256 + sample) * 4;
            const amplitude = rgba[offset + 3]! / 255;
            const beatPulse = Math.exp(-(((beat % 1) + 1) % 1) * 6);
            const travelingPulse = Math.exp(-((((beat - row * 0.25) % 1) + 1) % 1) * 6);
            const pulse = beatPulse * 0.55 + travelingPulse * 0.45;
            // Continuous travel, with recycling hidden at the near/far boundaries.
            const travel = (((row - beat / 4) % rows) + rows) % rows;
            const relief =
              0.5 + 0.5 * Math.sin(column * 1.7 + row * 0.63 + lane * 2.1 + beat * 0.025);
            const depth =
              0.12 +
              relief * 0.6 +
              amplitude * gain * (0.45 + energy[lane * 4 + 1]! * 0.6) +
              pulse * gain * 0.12 +
              dance.bounce * groove * 0.07;
            const x = (column * 3 + lane - 11.5) * 0.31 * width;
            const z = 2.2 - travel * 0.68;
            const fade =
              THREE.MathUtils.smoothstep(travel, 0, 2) *
              (1 - THREE.MathUtils.smoothstep(travel, rows - 4, rows));
            const hue = waveformAccent(
              [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!],
              amplitude,
              pulse,
            );
            for (let side = 0; side < 4; side++) {
              const index = (row * columns + column) * 4 + side;
              const sign = side % 2 ? 1 : -1;
              const wall = side > 1;
              const inner = (wall ? 3.45 * width : 1.85) - depth * 0.8;
              const position = sign * (inner + depth / 2);
              if (wall) {
                object.position.set(position, ((column * 3 + lane - 11.5) / 11.5) * 1.8, z);
                object.scale.set(depth, 0.14, 0.59);
              } else {
                object.position.set(x, position, z);
                object.scale.set(0.28 * width, depth, 0.59);
              }
              object.rotation.set(
                wall ? (motion[lane * 4]! * 0.1 + dance.nod * 0.035) * groove : 0,
                wall ? 0 : (motion[lane * 4]! * 0.1 + dance.twist * 0.035) * groove,
                0,
              );
              object.updateMatrix();
              body.setMatrixAt(index, object.matrix);
              signalColor.setRGB(...hue).convertSRGBToLinear();
              color
                .copy(stonePalette[lane]!)
                .lerp(signalColor, gain * 0.38)
                .multiplyScalar((0.48 + gain * 0.22) * fade);
              body.setColorAt(index, color);
              // A thin lit front edge reveals geometry without outlining every triangle.
              if (wall) {
                object.position.x = sign * (inner + 0.005);
                object.scale.set(0.012 + pulse * 0.022, 0.13, 0.01);
              } else {
                object.position.y = sign * (inner + 0.005);
                object.scale.set(0.27 * width, 0.012 + pulse * 0.022, 0.01);
              }
              object.position.z = z + 0.297;
              object.updateMatrix();
              edge.setMatrixAt(index, object.matrix);
              color
                .copy(stonePalette[lane]!)
                .lerp(signalColor, gain * 0.65)
                .multiplyScalar(fade * (0.2 + gain * (0.28 + amplitude * 0.45 + pulse * 0.55)));
              edge.setColorAt(index, color);
            }
          }
        body.instanceMatrix.needsUpdate = edge.instanceMatrix.needsUpdate = true;
        body.instanceColor!.needsUpdate = edge.instanceColor!.needsUpdate = true;
      }
    },
  };
}
