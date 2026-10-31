import * as THREE from "three";

type Station = { z: number; width: number; top: number; bottom: number };
type Point = [number, number, number];

/** An authored, metre-scale racing airframe. Forward is -Z; exhaust grows from +Z. */
export function createArcadeRacer(
  paint: number,
  geometries: Set<THREE.BufferGeometry>,
  materials: Set<THREE.Material>,
): { group: THREE.Group; flames: THREE.Mesh[] } {
  const group = new THREE.Group();
  group.name = "Arrowhead racing airframe";
  const flames: THREE.Mesh[] = [];
  const finish = (color: number, shininess = 24) => {
    const material = new THREE.MeshPhongMaterial({
      color,
      specular: 0x20252b,
      shininess,
      flatShading: true,
    });
    materials.add(material);
    return material;
  };
  const ivory = finish(0xdeddd2);
  const graphite = finish(0x242c34);
  const accent = finish(paint);
  const glass = finish(0x142b39, 65);
  const metal = finish(0x56626a, 35);
  const exhaust = new THREE.MeshBasicMaterial({ color: 0x8dcced });
  materials.add(exhaust);

  // Explicit outward-facing triangles keep the bevels crisp without back-face materials.
  function surface(points: Point[], faces: { vertices: number[]; material?: number }[]) {
    const positions: number[] = [];
    const geometry = new THREE.BufferGeometry();
    // Keep each material contiguous: a bevel must not cost a separate draw call.
    let activeMaterial = -1;
    let groupStart = 0;
    for (const face of [...faces].sort((a, b) => (a.material ?? 0) - (b.material ?? 0))) {
      const start = positions.length / 3;
      const material = face.material ?? 0;
      if (material !== activeMaterial) {
        if (activeMaterial >= 0) geometry.addGroup(groupStart, start - groupStart, activeMaterial);
        activeMaterial = material;
        groupStart = start;
      }
      for (let i = 1; i < face.vertices.length - 1; i++) {
        for (const index of [face.vertices[0]!, face.vertices[i]!, face.vertices[i + 1]!]) {
          positions.push(...points[index]!);
        }
      }
    }
    geometry.addGroup(groupStart, positions.length / 3 - groupStart, activeMaterial);
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    geometries.add(geometry);
    return geometry;
  }

  // Octagonal cross-sections: broad deck, chamfered shoulders, and a narrow dark belly.
  function loft(stations: Station[]) {
    const points: Point[] = [];
    const faces: { vertices: number[]; material?: number }[] = [];
    for (const { z, width: w, top: t, bottom: b } of stations) {
      const bevel = (t - b) * 0.26;
      points.push(
        [-w * 0.7, t, z],
        [w * 0.7, t, z],
        [w, t - bevel, z],
        [w, b + bevel, z],
        [w * 0.65, b, z],
        [-w * 0.65, b, z],
        [-w, b + bevel, z],
        [-w, t - bevel, z],
      );
    }
    faces.push({ vertices: [0, 1, 2, 3, 4, 5, 6, 7], material: 1 });
    for (let s = 0; s < stations.length - 1; s++) {
      for (let edge = 0; edge < 8; edge++) {
        const a = s * 8 + edge;
        const b = s * 8 + ((edge + 1) % 8);
        faces.push({
          vertices: [a, a + 8, b + 8, b],
          material: edge >= 3 && edge <= 5 ? 1 : 0,
        });
      }
    }
    const end = (stations.length - 1) * 8;
    faces.push({ vertices: [7, 6, 5, 4, 3, 2, 1, 0].map((i) => end + i), material: 1 });
    return surface(points, faces);
  }

  function add(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material | THREE.Material[],
    x = 0,
  ) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.x = x;
    group.add(mesh);
    return mesh;
  }

  // The deck rises gently toward the cockpit then falls away into the rear transom.
  const fuselage: Station[] = [
    { z: -2.5, width: 0.025, top: -0.025, bottom: -0.08 },
    { z: -1.45, width: 0.38, top: 0.15, bottom: -0.19 },
    { z: -0.45, width: 0.64, top: 0.25, bottom: -0.27 },
    { z: 0.7, width: 0.61, top: 0.23, bottom: -0.27 },
    { z: 1.85, width: 0.39, top: 0.08, bottom: -0.2 },
  ];
  add("Ivory monocoque / graphite keel", loft(fuselage), [ivory, graphite]);
  add(
    "Continuous racing spine",
    loft(
      fuselage.map((s) => ({
        ...s,
        width: Math.min(s.width * 0.62, 0.115),
        top: s.top + 0.008,
        bottom: s.top + 0.003,
      })),
    ),
    accent,
  );
  add(
    "Recessed smoked cockpit",
    loft([
      { z: -0.95, width: 0.16, top: 0.21, bottom: 0.18 },
      { z: -0.32, width: 0.34, top: 0.58, bottom: 0.245 },
      { z: 0.42, width: 0.31, top: 0.55, bottom: 0.235 },
      { z: 0.79, width: 0.22, top: 0.22, bottom: 0.21 },
    ]),
    [glass, graphite],
  );

  // Wings are swept plates, not rotated boxes. Both sides share their engine tooling.
  const pod = loft([
    { z: -0.64, width: 0.18, top: 0.04, bottom: -0.19 },
    { z: -0.12, width: 0.32, top: 0.25, bottom: -0.3 },
    { z: 1.61, width: 0.32, top: 0.23, bottom: -0.3 },
    { z: 2.12, width: 0.25, top: 0.1, bottom: -0.25 },
  ]);
  const collar = loft([
    { z: 1.96, width: 0.268, top: 0.15, bottom: -0.28 },
    { z: 2.19, width: 0.255, top: 0.115, bottom: -0.265 },
  ]);
  const intake = loft([
    { z: -0.655, width: 0.145, top: 0.015, bottom: -0.16 },
    { z: -0.64, width: 0.145, top: 0.015, bottom: -0.16 },
  ]);
  // Flame geometry starts at zero, so animation stretches the plume without moving its root.
  const plume = loft([
    { z: 0, width: 0.175, top: 0.11, bottom: -0.11 },
    { z: 0.18, width: 0.13, top: 0.075, bottom: -0.075 },
    { z: 0.85, width: 0.008, top: 0.006, bottom: -0.006 },
  ]);
  for (const side of [-1, 1]) {
    // Polygon order reverses with mirroring to preserve face winding.
    function plate(outline: [number, number][], top: number, bottom: number) {
      const polygon = side === 1 ? outline : [...outline].reverse();
      const points: Point[] = polygon.map(([x, z]) => [side * x, top, z]);
      points.push(...polygon.map(([x, z]): Point => [side * x, bottom, z]));
      const n = polygon.length;
      const faces = [
        { vertices: Array.from({ length: n }, (_, i) => n - 1 - i), material: 0 },
        { vertices: Array.from({ length: n }, (_, i) => n + i), material: 1 },
      ];
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        faces.push({ vertices: [i, next, next + n, i + n], material: 1 });
      }
      return surface(points, faces);
    }
    add(
      "Swept stabilizer",
      plate(
        [
          [0.48, -0.67],
          [0.85, -0.39],
          [1.92, 1.05],
          [1.82, 1.72],
          [0.45, 1.16],
        ],
        -0.025,
        -0.16,
      ),
      [ivory, graphite],
    );
    add(
      "Wing racing flash",
      plate(
        [
          [0.8, -0.22],
          [0.99, 0.02],
          [1.82, 1.12],
          [1.76, 1.39],
        ],
        -0.017,
        -0.023,
      ),
      accent,
    );
    add("Armored turbine nacelle", pod, [ivory, graphite], side * 1.24);
    add("Recessed ram intake", intake, graphite, side * 1.24);
    add("Titanium exhaust collar", collar, [metal, graphite], side * 1.24);

    const finPoints: Point[] = [
      [side * 1.19, 0.23, 0.49],
      [side * 1.32, 0.76, 1.16],
      [side * 1.35, 0.71, 1.94],
      [side * 1.19, 0.13, 1.94],
      [side * 1.27, 0.23, 0.49],
      [side * 1.39, 0.76, 1.16],
      [side * 1.42, 0.71, 1.94],
      [side * 1.27, 0.13, 1.94],
    ];
    const finFaces = [
      [0, 1, 2, 3],
      [7, 6, 5, 4],
      [0, 4, 5, 1],
      [1, 5, 6, 2],
      [2, 6, 7, 3],
      [3, 7, 4, 0],
    ];
    add(
      "Canted scarlet tail fin",
      surface(
        finPoints,
        finFaces.map((vertices, i) => ({
          vertices: side === 1 ? [...vertices].reverse() : vertices,
          material: i < 2 ? 0 : 1,
        })),
      ),
      [accent, graphite],
    );

    // Three dark deck louvers in one mesh per engine.
    const ventPoints: Point[] = [];
    const ventFaces: { vertices: number[] }[] = [];
    for (let i = 0; i < 3; i++) {
      const z = 0.05 + i * 0.16;
      const y = 0.25 - (z + 0.12) * (0.02 / 1.73) + 0.006;
      const x = side * 1.24;
      const start = ventPoints.length;
      ventPoints.push(
        [x - 0.18, y, z],
        [x - 0.18, y, z + 0.07],
        [x + 0.18, y, z + 0.07],
        [x + 0.18, y, z],
      );
      ventFaces.push({ vertices: [start, start + 1, start + 2, start + 3] });
    }
    add("Engine deck louvers", surface(ventPoints, ventFaces), graphite);
    const flame = add("Pale blue turbine exhaust", plume, exhaust, side * 1.24);
    flame.position.set(side * 1.24, -0.075, 2.195);
    flames.push(flame);
  }
  return { group, flames };
}
