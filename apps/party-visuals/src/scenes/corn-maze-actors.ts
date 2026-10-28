import * as THREE from "three";

export type ActorKind = "skeleton" | "ghost" | "witch" | "pumpkin" | "shadow";

/**
 * A scare actor hiding in the corn. Each one is built from primitives, stands with its feet at
 * the origin facing +z, and is posed between at rest (fright 0) and mid-scare (fright 1).
 */
export type Actor = {
  kind: ActorKind;
  root: THREE.Group;
  /** Height of the face, for the camera to look at. */
  face: number;
  pose(time: number, fright: number): void;
};

/** Bright enough to bloom; eyes ignore the fog so they read from deep in the dark. */
const glow = (hex: number, strength: number) =>
  new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(strength), fog: false });

function builder(root: THREE.Object3D) {
  return (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0, parent = root) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
}

/** A limb hanging down from a joint at (x, y, z); returns the joint so it can swing. */
function limb(parent: THREE.Object3D, material: THREE.Material, x: number, y: number, z: number, length: number, radius: number) {
  const joint = new THREE.Group();
  joint.position.set(x, y, z);
  parent.add(joint);
  const bone = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.8, length, 6), material);
  bone.position.y = -length / 2;
  joint.add(bone);
  const end = new THREE.Group();
  end.position.y = -length;
  joint.add(end);
  return { joint, end };
}

function skeleton(): Actor {
  const root = new THREE.Group();
  const add = builder(root);
  const bone = new THREE.MeshStandardMaterial({ color: 0xb9b19a, roughness: 0.9, emissive: 0x141108 });
  const hollow = new THREE.MeshBasicMaterial({ color: 0x050302 });
  const ember = glow(0xff3010, 6);

  const head = new THREE.Group();
  head.position.set(0, 1.62, 0);
  root.add(head);
  const skull = add(new THREE.SphereGeometry(0.16, 20, 16), bone, 0, 0.09, 0, head);
  skull.scale.set(0.92, 1.05, 1);
  for (const side of [-1, 1]) {
    add(new THREE.SphereGeometry(0.048, 12, 8), hollow, side * 0.058, 0.1, 0.122, head).scale.z = 0.5;
    add(new THREE.SphereGeometry(0.016, 8, 6), ember, side * 0.058, 0.1, 0.14, head);
  }
  add(new THREE.ConeGeometry(0.022, 0.05, 3), hollow, 0, 0.035, 0.15, head).rotation.x = Math.PI;
  add(new THREE.BoxGeometry(0.14, 0.03, 0.02), bone, 0, -0.005, 0.135, head);
  const jaw = new THREE.Group();
  jaw.position.set(0, -0.01, 0.02);
  head.add(jaw);
  add(new THREE.BoxGeometry(0.15, 0.05, 0.13), bone, 0, -0.045, 0.05, jaw);

  add(new THREE.CylinderGeometry(0.025, 0.025, 0.62, 6), bone, 0, 1.2, -0.03);
  for (let k = 0; k < 4; k++) {
    const rib = add(new THREE.TorusGeometry(0.17 - k * 0.018, 0.014, 6, 20, Math.PI * 1.6), bone, 0, 1.45 - k * 0.08, 0.02);
    rib.rotation.set(Math.PI / 2, 0, Math.PI * 0.7);
    rib.scale.set(1, 0.75, 1);
  }
  add(new THREE.TorusGeometry(0.12, 0.03, 6, 16), bone, 0, 0.93, 0).rotation.x = Math.PI / 2;

  const arms = [-1, 1].map((side) => {
    const upper = limb(root, bone, side * 0.21, 1.46, 0, 0.32, 0.022);
    const fore = limb(upper.end, bone, 0, 0, 0, 0.3, 0.018);
    for (let f = -1; f <= 1; f++) add(new THREE.CylinderGeometry(0.007, 0.005, 0.1, 4), bone, f * 0.02, -0.05, 0, fore.end);
    return { side, upper: upper.joint, fore: fore.joint };
  });
  for (const side of [-1, 1]) {
    const thigh = limb(root, bone, side * 0.09, 0.9, 0, 0.44, 0.026);
    limb(thigh.end, bone, 0, 0, 0, 0.42, 0.022);
  }

  return {
    kind: "skeleton",
    root,
    face: 1.7,
    pose(time, fright) {
      jaw.rotation.x = fright * (0.3 + 0.25 * Math.sin(time * 34)) + 0.03;
      head.rotation.z = Math.sin(time * 3.1) * 0.12 + fright * Math.sin(time * 19) * 0.08;
      head.rotation.x = -fright * 0.2;
      for (const arm of arms) {
        arm.upper.rotation.x = -fright * 1.55 + Math.sin(time * 2 + arm.side) * 0.06;
        arm.upper.rotation.z = arm.side * (0.12 + fright * 0.35);
        arm.fore.rotation.x = -fright * (0.35 + 0.2 * Math.sin(time * 22 + arm.side));
      }
    },
  };
}

function ghost(): Actor {
  const root = new THREE.Group();
  const add = builder(root);
  const veil = new THREE.MeshStandardMaterial({
    color: 0xdceeff,
    emissive: 0x7fb8ff,
    emissiveIntensity: 0.55,
    transparent: true,
    opacity: 0.78,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const hollow = new THREE.MeshBasicMaterial({ color: 0x020308, transparent: true, opacity: 0.92 });

  const profile = [
    [0, 2.02],
    [0.16, 1.99],
    [0.3, 1.9],
    [0.38, 1.7],
    [0.4, 1.4],
    [0.44, 1.0],
    [0.52, 0.62],
    [0.62, 0.35],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const shroud = new THREE.LatheGeometry(profile, 32);
  // A scalloped, ragged hem.
  const position = shroud.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i);
    const hem = THREE.MathUtils.smoothstep(1.0 - y, 0, 0.6);
    const angle = Math.atan2(position.getX(i), position.getZ(i));
    position.setY(i, y + Math.sin(angle * 9) * 0.09 * hem);
  }
  shroud.computeVertexNormals();
  const body = add(shroud, veil);
  const eyes = [-1, 1].map((side) => {
    const eye = add(new THREE.SphereGeometry(0.075, 14, 10), hollow, side * 0.13, 1.68, 0.34);
    eye.scale.set(0.9, 1.4, 0.45);
    eye.rotation.z = side * 0.25;
    return eye;
  });
  const mouth = add(new THREE.SphereGeometry(0.08, 14, 10), hollow, 0, 1.42, 0.38);
  mouth.scale.set(0.9, 1.3, 0.4);
  const arms = [-1, 1].map((side) => {
    const joint = new THREE.Group();
    joint.position.set(side * 0.36, 1.48, 0.05);
    root.add(joint);
    add(new THREE.ConeGeometry(0.12, 0.55, 10, 1, true), veil, 0, -0.26, 0, joint);
    return { side, joint };
  });

  return {
    kind: "ghost",
    root,
    face: 1.6,
    pose(time, fright) {
      body.rotation.y = Math.sin(time * 1.7) * 0.12;
      body.scale.set(1 + Math.sin(time * 5) * 0.03, 1 + fright * 0.08, 1 + Math.sin(time * 4.3) * 0.03);
      mouth.scale.set(0.9 - fright * 0.2, 1.3 + fright * 2.2 + Math.sin(time * 40) * 0.2 * fright, 0.4);
      mouth.position.y = 1.42 - fright * 0.08;
      for (const eye of eyes) eye.scale.y = 1.4 + fright * 0.5;
      for (const arm of arms) {
        arm.joint.rotation.x = -0.3 - fright * 1.2 + Math.sin(time * 3 + arm.side) * 0.15;
        arm.joint.rotation.z = arm.side * (0.25 + fright * 0.15);
      }
      veil.emissiveIntensity = 0.5 + fright * 0.6;
    },
  };
}

function witch(): Actor {
  const root = new THREE.Group();
  const add = builder(root);
  const robe = new THREE.MeshStandardMaterial({ color: 0x2a1640, roughness: 0.9, emissive: 0x12061e });
  const skin = new THREE.MeshStandardMaterial({ color: 0x7cc046, roughness: 0.6, emissive: 0x2c5a10 });
  const hair = new THREE.MeshStandardMaterial({ color: 0x3b3a40, roughness: 1 });
  const band = new THREE.MeshStandardMaterial({ color: 0x7a2ba8, emissive: 0x2a0840 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x4a3018, roughness: 1 });
  const straw = new THREE.MeshStandardMaterial({ color: 0xb08a3a, roughness: 1 });
  const hollow = new THREE.MeshBasicMaterial({ color: 0x080204 });
  const eyesGlow = glow(0xffe23a, 2.5);

  add(new THREE.ConeGeometry(0.5, 1.45, 16, 1, true), robe, 0, 0.72, 0);
  add(new THREE.SphereGeometry(0.21, 14, 10), robe, 0, 1.4, 0).scale.set(1.2, 0.8, 0.9);
  const head = new THREE.Group();
  head.position.set(0, 1.62, 0);
  root.add(head);
  add(new THREE.SphereGeometry(0.155, 18, 14), skin, 0, 0, 0, head).scale.set(0.95, 1.1, 1);
  add(new THREE.ConeGeometry(0.03, 0.17, 8), skin, 0, -0.01, 0.2, head).rotation.x = Math.PI / 2 + 0.3;
  add(new THREE.ConeGeometry(0.04, 0.12, 8), skin, 0, -0.17, 0.09, head).rotation.x = Math.PI - 0.5;
  for (const side of [-1, 1]) add(new THREE.SphereGeometry(0.024, 8, 6), eyesGlow, side * 0.058, 0.04, 0.135, head);
  const mouth = add(new THREE.BoxGeometry(0.09, 0.02, 0.02), hollow, 0, -0.075, 0.135, head);
  for (let k = 0; k < 9; k++) {
    const angle = Math.PI * (0.35 + (k / 8) * 1.3);
    const lock = add(new THREE.BoxGeometry(0.04, 0.55, 0.02), hair, Math.cos(angle) * 0.15, -0.18, Math.sin(angle) * -0.13, head);
    lock.rotation.set(Math.sin(angle) * 0.2, 0, Math.cos(angle) * -0.2);
  }
  const hat = new THREE.Group();
  hat.position.y = 0.12;
  hat.rotation.z = 0.12;
  head.add(hat);
  add(new THREE.CylinderGeometry(0.38, 0.38, 0.02, 24), robe, 0, 0, 0, hat);
  add(new THREE.CylinderGeometry(0.175, 0.18, 0.06, 20), band, 0, 0.04, 0, hat);
  const tip = add(new THREE.ConeGeometry(0.18, 0.6, 20), robe, 0, 0.3, 0, hat);
  tip.rotation.z = 0.15;

  const arms = [-1, 1].map((side) => {
    const sleeve = limb(root, robe, side * 0.24, 1.42, 0, 0.5, 0.06);
    add(new THREE.SphereGeometry(0.045, 10, 8), skin, 0, 0, 0, sleeve.end);
    for (let f = -1; f <= 1; f++) {
      const finger = add(new THREE.CylinderGeometry(0.008, 0.004, 0.13, 4), skin, f * 0.022, -0.07, 0.01, sleeve.end);
      finger.rotation.x = 0.3;
    }
    return { side, joint: sleeve.joint };
  });

  const broom = new THREE.Group();
  broom.position.set(0, 0.55, 0);
  root.add(broom);
  add(new THREE.CylinderGeometry(0.025, 0.025, 1.9, 6), wood, 0, 0, 0, broom).rotation.x = Math.PI / 2;
  const bristles = add(new THREE.ConeGeometry(0.16, 0.5, 10, 1, true), straw, 0, 0, -1.1, broom);
  bristles.rotation.x = -Math.PI / 2;

  return {
    kind: "witch",
    root,
    face: 1.65,
    pose(time, fright) {
      // A cackle: head thrown back and shaking, mouth wide, claws up.
      head.rotation.x = -fright * (0.25 + 0.1 * Math.sin(time * 26));
      head.rotation.z = Math.sin(time * 2.3) * 0.1;
      mouth.scale.y = 1 + fright * (4 + 2 * Math.sin(time * 30));
      for (const arm of arms) {
        arm.joint.rotation.x = -fright * (1.9 + Math.sin(time * 9 + arm.side) * 0.2);
        arm.joint.rotation.z = arm.side * (0.2 + fright * 0.5);
      }
      broom.rotation.z = Math.sin(time * 3) * 0.06;
    },
  };
}

function pumpkin(): Actor {
  const root = new THREE.Group();
  const add = builder(root);
  const wood = new THREE.MeshStandardMaterial({ color: 0x4b3420, roughness: 1 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0x7c2c1a, roughness: 1 });
  const denim = new THREE.MeshStandardMaterial({ color: 0x2c3a55, roughness: 1 });
  const straw = new THREE.MeshStandardMaterial({ color: 0xc9a650, roughness: 1 });
  const rind = new THREE.MeshStandardMaterial({ color: 0xc0561a, roughness: 0.7, emissive: 0x0a0300 });
  const stem = new THREE.MeshStandardMaterial({ color: 0x4d5a22, roughness: 1 });
  const candle = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffa020).multiplyScalar(3), fog: false });

  add(new THREE.CylinderGeometry(0.05, 0.06, 2.4, 6), wood, 0, 1.2, -0.12);
  add(new THREE.CylinderGeometry(0.04, 0.04, 1.6, 6), wood, 0, 1.42, -0.12).rotation.z = Math.PI / 2;
  add(new THREE.BoxGeometry(0.56, 0.62, 0.3), shirt, 0, 1.25, 0);
  for (const side of [-1, 1]) {
    add(new THREE.BoxGeometry(0.2, 0.7, 0.22), denim, side * 0.13, 0.62, 0);
    add(new THREE.ConeGeometry(0.1, 0.25, 6), straw, side * 0.13, 0.2, 0);
  }

  const torso = new THREE.Group();
  torso.position.y = 1.42;
  root.add(torso);
  const arms = [-1, 1].map((side) => {
    const joint = new THREE.Group();
    joint.position.set(side * 0.26, 0, 0);
    torso.add(joint);
    add(new THREE.BoxGeometry(0.5, 0.16, 0.18), shirt, side * 0.25, 0, 0, joint);
    add(new THREE.ConeGeometry(0.08, 0.28, 6), straw, side * 0.62, 0, 0, joint).rotation.z = side * -Math.PI / 2;
    return { side, joint };
  });

  const head = new THREE.Group();
  head.position.y = 1.83;
  root.add(head);
  const shell = new THREE.SphereGeometry(0.27, 28, 18);
  const position = shell.getAttribute("position") as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const ridge = 1 - 0.07 * Math.pow(Math.abs(Math.cos(Math.atan2(v.x, v.z) * 4)), 0.5);
    position.setXYZ(i, v.x * ridge * 1.12, v.y * 0.85, v.z * ridge * 1.12);
  }
  shell.computeVertexNormals();
  add(shell, rind, 0, 0, 0, head);
  add(new THREE.CylinderGeometry(0.03, 0.045, 0.12, 6), stem, 0.01, 0.25, 0, head).rotation.z = 0.25;
  for (const side of [-1, 1]) {
    const eye = add(new THREE.CircleGeometry(0.07, 3), candle, side * 0.1, 0.06, 0.285, head);
    eye.rotation.z = Math.PI / 2;
  }
  add(new THREE.CircleGeometry(0.035, 3), candle, 0, -0.01, 0.3, head).rotation.z = Math.PI / 2;
  const grin = new THREE.Shape();
  grin.moveTo(-0.17, 0);
  for (let k = 0; k <= 8; k++) grin.lineTo(-0.17 + (k / 8) * 0.34, k % 2 ? -0.03 : 0.01);
  grin.quadraticCurveTo(0, -0.18, -0.17, 0);
  add(new THREE.ShapeGeometry(grin), candle, 0, -0.06, 0.29, head);
  const brim = add(new THREE.CylinderGeometry(0.4, 0.42, 0.03, 20), straw, 0, 0.22, 0, head);
  add(new THREE.CylinderGeometry(0.17, 0.22, 0.2, 16), straw, 0, 0.32, 0, head);
  brim.rotation.x = 0.1;

  return {
    kind: "pumpkin",
    root,
    face: 1.85,
    pose(time, fright) {
      // It was just a scarecrow… until the head snaps round and it lunges off the post.
      head.rotation.z = Math.sin(time * 1.2) * 0.08 + fright * 0.35 * Math.sin(time * 14);
      head.rotation.x = -fright * 0.15;
      torso.rotation.x = fright * 0.35;
      for (const arm of arms) arm.joint.rotation.y = arm.side * -fright * (1.1 + Math.sin(time * 18 + arm.side) * 0.15);
      candle.color.setHex(0xffa020).multiplyScalar(1.6 + fright * 1.4 + Math.sin(time * 23) * 0.3);
    },
  };
}

function shadow(): Actor {
  const root = new THREE.Group();
  const add = builder(root);
  const void_ = new THREE.MeshStandardMaterial({ color: 0x050407, roughness: 1 });
  const ember = glow(0xff1414, 8);
  const smile = glow(0xc9b8a8, 1.6);

  add(new THREE.CapsuleGeometry(0.22, 1.5, 6, 12), void_, 0, 1.3, 0).scale.set(1, 1, 0.6);
  const head = new THREE.Group();
  head.position.y = 2.36;
  root.add(head);
  add(new THREE.SphereGeometry(0.17, 16, 12), void_, 0, 0, 0, head).scale.set(0.85, 1.25, 0.9);
  for (const side of [-1, 1]) add(new THREE.SphereGeometry(0.028, 8, 6), ember, side * 0.06, 0.04, 0.135, head);
  const grin = add(new THREE.TorusGeometry(0.075, 0.007, 4, 16, Math.PI), smile, 0, -0.06, 0.14, head);
  grin.rotation.z = Math.PI;
  const arms = [-1, 1].map((side) => {
    const arm = limb(root, void_, side * 0.28, 2.02, 0, 1.2, 0.045);
    for (let f = -2; f <= 2; f++) {
      const finger = add(new THREE.CylinderGeometry(0.008, 0.003, 0.24, 4), void_, f * 0.018, -0.1, 0, arm.end);
      finger.rotation.z = f * 0.12;
    }
    return { side, joint: arm.joint };
  });

  return {
    kind: "shadow",
    root,
    face: 2.38,
    pose(time, fright) {
      // Jerky, broken-neck tilts that snap between angles instead of easing.
      const snap = Math.floor(time * 3.5);
      head.rotation.z = Math.sin(snap * 2.7) * 0.4 * (0.3 + fright);
      grin.scale.setScalar(1 + fright * 0.6);
      for (const arm of arms) {
        arm.joint.rotation.x = -fright * (1.3 + Math.sin(time * 6 + arm.side) * 0.1);
        arm.joint.rotation.z = arm.side * (0.08 + fright * 0.25);
      }
    },
  };
}

export const ACTOR_KINDS: ActorKind[] = ["skeleton", "ghost", "witch", "pumpkin", "shadow"];

export function createActor(kind: ActorKind): Actor {
  switch (kind) {
    case "skeleton":
      return skeleton();
    case "ghost":
      return ghost();
    case "witch":
      return witch();
    case "pumpkin":
      return pumpkin();
    case "shadow":
      return shadow();
  }
}

export function disposeActor(actor: Actor) {
  actor.root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    (object.material as THREE.Material).dispose();
  });
}
