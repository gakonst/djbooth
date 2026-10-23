import * as THREE from "three";

/** Two articulated paper silhouettes, facing the camera along local +Z. */
export function createDancingHaunts(): {
  group: THREE.Group;
  update(time: number, beat: number, energy: number, motion: number): void;
  dispose(): void;
} {
  const group = new THREE.Group();
  group.name = "dancing-paper-haunts";
  const paper = new THREE.MeshBasicMaterial({ color: 0xe1d6af, side: THREE.DoubleSide });
  const ink = new THREE.MeshBasicMaterial({ color: 0x100e0c, side: THREE.DoubleSide });
  const red = new THREE.MeshBasicMaterial({ color: 0x992e2a, side: THREE.DoubleSide });
  const faded = new THREE.MeshBasicMaterial({ color: 0xb5a77e, side: THREE.DoubleSide });
  const geometries = new Set<THREE.BufferGeometry>();
  const circle = new THREE.CircleGeometry(1, 16);
  geometries.add(circle);
  function silhouette(parent: THREE.Group, path: THREE.Shape, material = paper, z = 0) {
    const geometry = new THREE.ShapeGeometry(path, 16);
    geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = z;
    parent.add(mesh);
    return mesh;
  }
  function oval(
    parent: THREE.Group,
    x: number,
    y: number,
    rx: number,
    ry: number,
    material = paper,
    z = 0.025,
  ) {
    const mesh = new THREE.Mesh(circle, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(rx, ry, 1);
    parent.add(mesh);
    return mesh;
  }
  function stroke(
    parent: THREE.Group,
    points: number[][],
    radius = 0.018,
    material = paper,
    z = 0.015,
  ) {
    const curve = new THREE.CatmullRomCurve3(
      points.map(([x = 0, y = 0]) => new THREE.Vector3(x, y, z)),
    );
    const geometry = new THREE.TubeGeometry(
      curve,
      Math.max(6, points.length * 4),
      radius,
      5,
      false,
    );
    geometries.add(geometry);
    parent.add(new THREE.Mesh(geometry, material));
  }
  function bone(parent: THREE.Group, length: number, width = 0.028) {
    stroke(
      parent,
      [
        [0, 0],
        [-0.011, -length * 0.35],
        [0.008, -length * 0.72],
        [0, -length],
      ],
      width,
    );
    for (const y of [-0.025, -length + 0.025]) {
      oval(parent, -width * 0.65, y, width, width * 1.15);
      oval(parent, width * 0.65, y, width, width * 1.15);
    }
  }
  const skeleton = new THREE.Group();
  skeleton.position.set(-0.72, -0.04, 0);
  group.add(skeleton);
  const torso = new THREE.Group();
  torso.position.y = 0.16;
  skeleton.add(torso);
  stroke(
    torso,
    [
      [0, -0.38],
      [-0.025, -0.1],
      [0.014, 0.2],
      [0, 0.52],
    ],
    0.027,
  );
  for (let i = 0; i < 5; i++) {
    const y = 0.39 - i * 0.105;
    const w = 0.25 - Math.abs(i - 1.5) * 0.025;
    for (const side of [-1, 1]) {
      stroke(
        torso,
        [
          [side * 0.025, y + 0.035],
          [side * w, y + 0.075],
          [side * (w + 0.018), y - 0.015],
          [side * 0.07, y - 0.045],
        ],
        0.017,
      );
    }
  }
  stroke(
    torso,
    [
      [-0.29, 0.48],
      [-0.15, 0.52],
      [0, 0.48],
      [0.16, 0.53],
      [0.29, 0.48],
    ],
    0.022,
  );
  const pelvis = new THREE.Shape();
  pelvis.moveTo(-0.23, -0.26);
  pelvis.bezierCurveTo(-0.28, -0.49, -0.17, -0.58, 0, -0.48);
  pelvis.bezierCurveTo(0.19, -0.58, 0.28, -0.43, 0.23, -0.26);
  pelvis.quadraticCurveTo(0, -0.42, -0.23, -0.26);
  silhouette(torso, pelvis);
  oval(torso, -0.115, -0.425, 0.055, 0.06, ink);
  oval(torso, 0.115, -0.425, 0.055, 0.06, ink);
  const head = new THREE.Group();
  head.position.set(0, 0.67, 0.02);
  torso.add(head);
  const skull = new THREE.Shape();
  skull.moveTo(-0.14, -0.12);
  skull.lineTo(-0.21, 0.02);
  skull.bezierCurveTo(-0.31, 0.42, 0.27, 0.48, 0.24, 0.12);
  skull.lineTo(0.17, -0.09);
  skull.lineTo(0.115, -0.2);
  skull.lineTo(-0.1, -0.215);
  skull.closePath();
  silhouette(head, skull);
  oval(head, -0.105, 0.105, 0.07, 0.088, ink).rotation.z = -0.2;
  oval(head, 0.105, 0.12, 0.066, 0.083, ink).rotation.z = 0.23;
  const nose = new THREE.Shape();
  nose.moveTo(0, 0.055);
  nose.lineTo(-0.037, -0.033);
  nose.lineTo(0.038, -0.027);
  nose.closePath();
  silhouette(head, nose, ink, 0.03);
  stroke(
    head,
    [
      [-0.11, -0.115],
      [0, -0.13],
      [0.12, -0.105],
    ],
    0.009,
    ink,
    0.04,
  );
  for (let i = 0; i < 5; i++)
    stroke(
      head,
      [
        [-0.08 + i * 0.04, -0.085],
        [-0.077 + i * 0.04, -0.174],
      ],
      0.006,
      ink,
      0.04,
    );

  function limb(
    parent: THREE.Group,
    x: number,
    y: number,
    upperLength: number,
    lowerLength: number,
    hand: boolean,
  ) {
    const upper = new THREE.Group();
    upper.position.set(x, y, 0);
    parent.add(upper);
    bone(upper, upperLength);
    const lower = new THREE.Group();
    lower.position.y = -upperLength;
    upper.add(lower);
    bone(lower, lowerLength, 0.023);
    if (hand) {
      oval(lower, 0, -lowerLength - 0.025, 0.042, 0.065);
      for (let i = 0; i < 5; i++) {
        const spread = (i - 2) * 0.025;
        stroke(
          lower,
          [
            [spread * 0.6, -lowerLength - 0.05],
            [spread * 1.5, -lowerLength - 0.12],
            [spread * 1.8 + 0.022, -lowerLength - 0.17 + Math.abs(i - 2) * 0.017],
          ],
          0.008,
        );
      }
    } else {
      stroke(
        lower,
        [
          [0, -lowerLength],
          [0.025, -lowerLength - 0.07],
          [0.16, -lowerLength - 0.085],
        ],
        0.032,
      );
      stroke(
        lower,
        [
          [0.065, -0.04],
          [0.055, -lowerLength + 0.025],
        ],
        0.012,
      );
    }
    return { upper, lower };
  }
  const leftArm = limb(torso, -0.29, 0.47, 0.36, 0.34, true);
  const rightArm = limb(torso, 0.29, 0.47, 0.36, 0.34, true);
  const leftLeg = limb(torso, -0.13, -0.48, 0.43, 0.42, false);
  const rightLeg = limb(torso, 0.13, -0.48, 0.43, 0.42, false);

  const ghost = new THREE.Group();
  ghost.position.set(0.77, 0.02, 0.04);
  group.add(ghost);
  const sheet = new THREE.Group();
  ghost.add(sheet);
  const fabric = new THREE.Shape();
  fabric.moveTo(-0.48, -0.65);
  fabric.bezierCurveTo(-0.38, -0.23, -0.38, 0.12, -0.35, 0.6);
  fabric.bezierCurveTo(-0.34, 1.16, 0.3, 1.24, 0.37, 0.66);
  fabric.bezierCurveTo(0.42, 0.1, 0.4, -0.26, 0.57, -0.63);
  fabric.bezierCurveTo(0.42, -0.53, 0.39, -0.82, 0.25, -0.68);
  fabric.bezierCurveTo(0.1, -0.53, 0.06, -0.85, -0.09, -0.7);
  fabric.bezierCurveTo(-0.26, -0.54, -0.3, -0.85, -0.48, -0.65);
  silhouette(sheet, fabric);
  oval(sheet, -0.135, 0.59, 0.065, 0.106, ink).rotation.z = -0.15;
  oval(sheet, 0.12, 0.6, 0.06, 0.095, ink).rotation.z = 0.15;
  for (const side of [-1, 1]) {
    stroke(
      sheet,
      [
        [side * 0.23, 0.24],
        [side * 0.19, -0.12],
        [side * 0.29, -0.51],
      ],
      0.008,
      faded,
      0.03,
    );
  }
  function sleeve(side: number) {
    const arm = new THREE.Group();
    arm.position.set(side * 0.32, 0.3, -0.01);
    sheet.add(arm);
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.12);
    shape.bezierCurveTo(side * 0.2, 0.11, side * 0.37, 0.4, side * 0.5, 0.42);
    shape.quadraticCurveTo(side * 0.51, 0.23, side * 0.4, 0.12);
    shape.quadraticCurveTo(side * 0.17, -0.22, 0, -0.17);
    shape.closePath();
    silhouette(arm, shape);
    return arm;
  }
  const ghostLeft = sleeve(-1);
  const ghostRight = sleeve(1);
  const boots: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const boot = new THREE.Group();
    boot.position.set(side * 0.2, -0.61, -0.02);
    ghost.add(boot);
    stroke(
      boot,
      [
        [0, 0],
        [side * 0.025, -0.37],
      ],
      0.055,
    );
    for (let i = 0; i < 5; i++)
      stroke(
        boot,
        [
          [-0.045, -0.06 - i * 0.055],
          [0.05, -0.075 - i * 0.055],
        ],
        0.014,
        red,
      );
    const shoe = new THREE.Shape();
    shoe.moveTo(-0.07, -0.3);
    shoe.lineTo(0.07, -0.3);
    shoe.lineTo(0.08, -0.42);
    shoe.quadraticCurveTo(0.27, -0.43, 0.23, -0.52);
    shoe.lineTo(-0.075, -0.52);
    shoe.closePath();
    silhouette(boot, shoe, ink);
    stroke(
      boot,
      [
        [-0.07, -0.52],
        [0.21, -0.52],
      ],
      0.012,
      paper,
      0.02,
    );
    boots.push(boot);
  }
  // Sparse misregistered red marks suggest an old two-colour relief print.
  stroke(
    head,
    [
      [-0.24, 0.2],
      [-0.255, 0.32],
      [-0.15, 0.4],
    ],
    0.009,
    red,
  );
  stroke(
    torso,
    [
      [-0.07, 0.53],
      [0.05, 0.49],
      [0.12, 0.54],
    ],
    0.018,
    red,
    0.04,
  );
  stroke(
    sheet,
    [
      [0.34, 0.78],
      [0.38, 0.53],
      [0.39, 0.3],
    ],
    0.009,
    red,
    0.035,
  );

  return {
    group,
    update(time, beat, energy, motion) {
      const drive = THREE.MathUtils.clamp(energy, 0, 1) * THREE.MathUtils.clamp(motion, 0, 1);
      const kick = THREE.MathUtils.clamp(beat, 0, 1) * drive;
      const phase = time * 5.4;
      const sway = Math.sin(phase);
      const idle = Math.sin(time * 1.3) * 0.018;
      skeleton.rotation.z = idle + sway * drive * 0.1;
      skeleton.position.y = -0.04 + kick * 0.075 + Math.sin(phase * 2) * drive * 0.025;
      head.rotation.z = -0.12 + idle + Math.sin(phase + 0.6) * drive * 0.16;
      leftArm.upper.rotation.z = -1.15 + sway * drive * 0.38;
      leftArm.lower.rotation.z = -1.15 + Math.sin(phase + 1) * drive * 0.35;
      rightArm.upper.rotation.z = 1.08 + sway * drive * 0.4;
      rightArm.lower.rotation.z = 1.2 + Math.sin(phase - 1) * drive * 0.4;
      leftLeg.upper.rotation.z = -0.25 + sway * drive * 0.32;
      rightLeg.upper.rotation.z = 0.24 - sway * drive * 0.32;
      leftLeg.lower.rotation.z = 0.18 + Math.max(0, -sway) * drive * 0.5;
      rightLeg.lower.rotation.z = -0.18 - Math.max(0, sway) * drive * 0.5;
      ghost.position.y = 0.02 + Math.sin(time * 1.4 + 1) * 0.025 + kick * 0.09;
      sheet.rotation.z = -idle - sway * drive * 0.09;
      sheet.scale.y = 1 + Math.sin(phase + 0.8) * drive * 0.025;
      ghostLeft.rotation.z = idle + Math.sin(phase + 1) * drive * 0.26;
      ghostRight.rotation.z = -idle + Math.sin(phase - 1) * drive * 0.3;
      boots.forEach((boot, i) => {
        boot.rotation.z = Math.sin(phase + i * Math.PI) * drive * 0.3;
      });
    },
    dispose() {
      geometries.forEach((geometry) => geometry.dispose());
      [paper, ink, red, faded].forEach((material) => material.dispose());
      group.clear();
    },
  };
}
