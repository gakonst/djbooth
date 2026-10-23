import * as THREE from "three";
import { waveformAccent } from "./waveform-signal.js";

/** Audio builds the room itself: each deck owns interleaved structural columns. */
export function createArchitectureBooth(scene: THREE.Scene) {
  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    metalness: 0.35,
    roughness: 0.65,
    dithering: true,
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
  scene.fog = new THREE.FogExp2(0x000000, 0.085);
  const ambient = new THREE.AmbientLight(0xffffff, 0.3);
  const key = new THREE.DirectionalLight(0xffffff, 4);
  key.position.set(-3, 5, 4);
  const fill = new THREE.DirectionalLight(0xffffff, 1);
  fill.position.set(4, -3, 2);
  group.add(ambient, key, fill);
  scene.add(group);
  const object = new THREE.Object3D(),
    color = new THREE.Color();
  return {
    dispose() {
      scene.remove(group);
      scene.fog = previousFog;
      lanes.forEach(({ body, edge }) => {
        body.dispose();
        edge.dispose();
      });
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
      group.rotation.z = Math.sin(time * 0.045) * 0.13;
      const width = Math.max(0.6, Math.sqrt(aspect));
      for (let lane = 0; lane < 3; lane++) {
        const { body, edge } = lanes[lane]!;
        const gain = Math.min(1, Math.sqrt(Math.max(0, energy[lane * 4]!)) * 1.7);
        const beat = motion[lane * 4 + 3]!;
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
              pulse * gain * 0.12;
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
                wall ? motion[lane * 4]! * 0.1 : 0,
                wall ? 0 : motion[lane * 4]! * 0.1,
                0,
              );
              object.updateMatrix();
              body.setMatrixAt(index, object.matrix);
              color
                .setRGB(...hue)
                .convertSRGBToLinear()
                .multiplyScalar((0.012 + gain * 0.065) * fade);
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
                .setRGB(...hue)
                .convertSRGBToLinear()
                .multiplyScalar(gain * fade * (0.28 + amplitude * 0.45 + pulse * 1.4));
              edge.setColorAt(index, color);
            }
          }
        body.instanceMatrix.needsUpdate = edge.instanceMatrix.needsUpdate = true;
        body.instanceColor!.needsUpdate = edge.instanceColor!.needsUpdate = true;
      }
    },
  };
}
