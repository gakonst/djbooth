import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

type Keeper = <T extends { dispose(): void }>(resource: T) => T;

/** Seeded, baked surface detail: no assets, animation allocations, or extra render passes. */
export function hauntedStoneTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const c = canvas.getContext("2d")!;
  let seed = 731;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  c.fillStyle = "#777987";
  c.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 6500; i++) {
    const v = 65 + Math.floor(random() * 105);
    c.fillStyle = `rgba(${v},${v},${v + 8},0.3)`;
    c.fillRect(random() * 256, random() * 256, 1 + random() * 3, 1 + random() * 2);
  }
  for (let y = 0; y < 256; y += 64) {
    c.strokeStyle = "#353441";
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(256, y);
    c.stroke();
    for (let x = y % 128 ? -32 : 0; x < 256; x += 64) {
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + 3, y + 64);
      c.stroke();
      c.strokeStyle = "#a2a0aa";
      c.lineWidth = 1;
      c.strokeRect(x + 6, y + 6, 52, 50);
      c.strokeStyle = "#474453";
      c.beginPath();
      c.moveTo(x + 21, y + 42);
      c.lineTo(x + 32, y + 18);
      c.lineTo(x + 43, y + 42);
      c.moveTo(x + 26, y + 32);
      c.lineTo(x + 38, y + 32);
      c.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** All clones share bounded geometry/materials owned by the scene's existing disposal list. */
export function createHauntedKit(keep: Keeper) {
  const map = keep(hauntedStoneTexture());
  const stone = keep(
    new THREE.MeshStandardMaterial({
      map,
      bumpMap: map,
      bumpScale: 0.055,
      color: 0x8b849a,
      roughness: 0.9,
    }),
  );
  const iron = keep(
    new THREE.MeshStandardMaterial({ color: 0x262331, metalness: 0.72, roughness: 0.38 }),
  );
  const ember = keep(
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa23e).multiplyScalar(2) }),
  );
  const frame = keep(new THREE.CylinderGeometry(0.23, 0.3, 0.12, 6));
  const roof = keep(new THREE.ConeGeometry(0.32, 0.26, 6));
  const bar = keep(new THREE.CylinderGeometry(0.018, 0.018, 0.48, 5));
  const flame = keep(new THREE.SphereGeometry(0.13, 10, 8));
  const handle = keep(new THREE.TorusGeometry(0.1, 0.018, 5, 12));
  const buildLantern = () => {
    const group = new THREE.Group();
    const base = new THREE.Mesh(frame, iron);
    group.add(base);
    const cap = new THREE.Mesh(roof, iron);
    cap.position.y = 0.61;
    group.add(cap);
    const heart = new THREE.Mesh(flame, ember);
    heart.position.y = 0.29;
    heart.scale.y = 1.6;
    group.add(heart);
    const loop = new THREE.Mesh(handle, iron);
    loop.position.y = 0.81;
    group.add(loop);
    for (let i = 0; i < 6; i++) {
      const rail = new THREE.Mesh(bar, iron);
      rail.position.set(
        Math.cos((i * Math.PI) / 3) * 0.22,
        0.29,
        Math.sin((i * Math.PI) / 3) * 0.22,
      );
      group.add(rail);
    }
    // Bake the cage into one mesh; each lantern is only two draw calls.
    group.updateMatrixWorld(true);
    const pieces: THREE.BufferGeometry[] = [];
    for (const child of group.children) {
      if (child instanceof THREE.Mesh && child.material === iron)
        pieces.push(child.geometry.clone().applyMatrix4(child.matrix));
    }
    const cage = keep(mergeGeometries(pieces)!);
    for (const piece of pieces) piece.dispose();
    group.clear();
    group.add(new THREE.Mesh(cage, iron), heart);
    return group;
  };
  const lanternTemplate = buildLantern();
  const lantern = () => lanternTemplate.clone(true);
  const sealCanvas = document.createElement("canvas");
  sealCanvas.width = sealCanvas.height = 256;
  const c = sealCanvas.getContext("2d")!;
  c.translate(128, 128);
  c.strokeStyle = "#86e8cf";
  c.lineWidth = 2;
  for (const r of [78, 100, 115]) {
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.stroke();
  }
  for (let i = 0; i < 24; i++) {
    c.save();
    c.rotate((i * Math.PI) / 12);
    c.beginPath();
    c.moveTo(0, -104);
    c.lineTo(0, -111);
    c.moveTo(-3, -89);
    c.lineTo(0, -95);
    c.lineTo(3, -89);
    c.stroke();
    c.restore();
  }
  c.beginPath();
  for (let i = 0; i <= 6; i++) {
    const a = (i * Math.PI * 2) / 3 - Math.PI / 2;
    c.lineTo(Math.cos(a) * 73, Math.sin(a) * 73);
  }
  c.stroke();
  const sealMap = keep(new THREE.CanvasTexture(sealCanvas));
  sealMap.colorSpace = THREE.SRGBColorSpace;
  const sealMaterial = keep(
    new THREE.MeshBasicMaterial({
      map: sealMap,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    }),
  );
  const sealGeometry = keep(new THREE.PlaneGeometry(2, 2));
  return { stone, iron, ember, lantern, seal: () => new THREE.Mesh(sealGeometry, sealMaterial) };
}

/** Batch repeated static props, leaving animated meshes and transparency independently sortable. */
export function instanceStaticProps(root: THREE.Group, animated = new Set<THREE.Object3D>()) {
  const batches = new Map<string, THREE.Mesh[]>();
  root.updateMatrixWorld(true);
  root.traverse((object) => {
    if (
      !(object instanceof THREE.Mesh) ||
      object instanceof THREE.InstancedMesh ||
      animated.has(object)
    )
      return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.some((material) => material.transparent)) return;
    const key = `${object.geometry.uuid}:${materials.map((material) => material.uuid).join(",")}:${object.castShadow}:${object.receiveShadow}`;
    const batch = batches.get(key) ?? [];
    batch.push(object);
    batches.set(key, batch);
  });
  const instances: THREE.InstancedMesh[] = [];
  const inverse = root.matrixWorld.clone().invert();
  const transform = new THREE.Matrix4();
  for (const meshes of batches.values()) {
    if (meshes.length < 2) continue;
    const first = meshes[0]!;
    const mesh = new THREE.InstancedMesh(first.geometry, first.material, meshes.length);
    mesh.castShadow = first.castShadow;
    mesh.receiveShadow = first.receiveShadow;
    meshes.forEach((source, i) => {
      mesh.setMatrixAt(i, transform.multiplyMatrices(inverse, source.matrixWorld));
      source.removeFromParent();
    });
    mesh.computeBoundingSphere();
    root.add(mesh);
    instances.push(mesh);
  }
  return instances;
}
