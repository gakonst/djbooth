import { createArchitectureBooth } from "./architecture-booth.js";
import { waveformAccent } from "./waveform-signal.js";
import * as THREE from "three";
import { PackedSplats, SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

export async function createSparkBooth(host: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.domElement.className = "booth-visuals spark-booth";
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.zIndex = "3";
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
  camera.position.z = 4.5;
  const spark = new SparkRenderer({ renderer, maxStdDev: 2 });
  scene.add(spark);
  // DOM hardware is visible through these colorless depth surfaces. Splats
  // behind z=0 are occluded; forward splats remain above the hardware image.
  const surface = new THREE.PlaneGeometry(1, 1);
  const depthMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
  });
  const hardware = Array.from(
    host.parentElement?.querySelectorAll<HTMLElement>(
      ".booth-grid > .cdj3000, .booth-grid > .djma9",
    ) ?? [],
  );
  const occluders = hardware.map((element) => {
    const plane = new THREE.Mesh(surface, depthMaterial);
    plane.renderOrder = -1;
    scene.add(plane);
    return { element, plane };
  });
  const architectural = new URLSearchParams(location.search).get("composition") === "architecture";
  const architecture = architectural ? createArchitectureBooth(scene) : undefined;
  const count = 256 * 24;
  const center = new THREE.Vector3(),
    scales = new THREE.Vector3(0.015, 0.015, 0.015);
  const rotation = new THREE.Quaternion(),
    color = new THREE.Color();
  const axis = new THREE.Vector3(1, 0, 0);
  const ahead = new THREE.Vector3(),
    direction = new THREE.Vector3();
  const lanes = Array.from({ length: architectural ? 0 : 3 }, () => {
    const packed = new PackedSplats({ maxSplats: count });
    for (let i = 0; i < count; i++) packed.pushSplat(center, scales, rotation, 0, color);
    const mesh = new SplatMesh({ packedSplats: packed });
    scene.add(mesh);
    return { packed, mesh };
  });
  const dispose = () => {
    lanes.forEach(({ mesh }) => mesh.dispose());
    architecture?.dispose();
    surface.dispose();
    depthMaterial.dispose();
    spark.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
    host.style.visibility = "";
  };
  try {
    await Promise.all(lanes.map(({ mesh }) => mesh.initialized));
  } catch (error) {
    dispose();
    throw error;
  }
  host.after(renderer.domElement);
  host.style.visibility = "hidden";
  let lastWidth = 0,
    lastHeight = 0;
  return {
    dispose,
    draw(
      time: number,
      rgba: Uint8Array,
      energy: Float32Array,
      motion: Float32Array,
      origins: Float32Array,
    ) {
      if (innerWidth !== lastWidth || innerHeight !== lastHeight) {
        lastWidth = innerWidth;
        lastHeight = innerHeight;
        renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
        renderer.setSize(innerWidth, innerHeight);
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
      }
      const halfHeight = Math.tan(THREE.MathUtils.degToRad(24)) * camera.position.z;
      const halfWidth = halfHeight * camera.aspect;
      for (const { element, plane } of occluders) {
        const rect = element.getBoundingClientRect();
        plane.position.set(
          (((rect.left + rect.width / 2) / innerWidth) * 2 - 1) * halfWidth,
          (1 - ((rect.top + rect.height / 2) / innerHeight) * 2) * halfHeight,
          0,
        );
        plane.scale.set(
          (rect.width / innerWidth) * halfWidth * 2,
          (rect.height / innerHeight) * halfHeight * 2,
          1,
        );
      }
      if (architecture) {
        architecture.draw(time, rgba, energy, motion, camera.aspect);
        renderer.render(scene, camera);
        return;
      }
      const span = Math.sqrt(camera.aspect);
      for (let lane = 0; lane < 3; lane++) {
        const { packed, mesh } = lanes[lane]!;
        const e = lane * 4;
        const level = Math.min(1, Math.sqrt(Math.max(0, energy[e]!)) * 1.7);
        const beat = motion[e + 3]!;
        const phase = time * 0.1 + beat * 0.065 + lane * 2.094;
        // A 32-beat phrase changes the balance between folded surfaces and
        // repeating architecture, without cutting away from any deck's signal.
        const phrase = 0.5 - 0.5 * Math.cos((beat * Math.PI) / 16);
        const path = (
          out: THREE.Vector3,
          u: number,
          strand: number,
          amplitude: number,
          pulse: number,
        ) => {
          const family = Math.floor(strand / 8),
            layer = strand % 8;
          const across = (layer - 3.5) / 3.5;
          const t = u * Math.PI * 2 + phase + motion[e]! * u * 0.4;
          const enter = THREE.MathUtils.smoothstep(u, 0, 0.2);
          let x: number, y: number, z: number;
          if (family === 0) {
            // The foreground voice is a narrow bundle of waveform filaments.
            // A restrained width keeps peaks legible instead of filling a band.
            const width =
              across * (0.025 + amplitude * 0.13 + pulse * 0.075) * (1 + motion[e + 1]! * 0.6);
            x = Math.sin(t) * 1.12 + Math.cos(t * 2) * width;
            y = Math.sin(t * 2) * (0.7 + phrase * 0.16) + Math.sin(t * 2) * width;
            z = Math.cos(t * 3) * 0.65 + width * Math.sin(t);
          } else if (family === 1) {
            // Successive beats launch expanding wavefronts into the shared room.
            const travel = ((((beat * 0.5 - layer) / 8) % 1) + 1) % 1;
            const radius = 0.15 + travel * 1.65;
            const angle = u * Math.PI * 2;
            const c = Math.cos(angle),
              s = Math.sin(angle);
            const roundness = 0.4 + 0.5 * phrase;
            const qx = Math.sign(c) * Math.pow(Math.abs(c), roundness);
            const qy = Math.sign(s) * Math.pow(Math.abs(s), roundness);
            const turn = Math.PI / 4 + Math.sin(phase * 0.6) * 0.38;
            const scale = radius * (0.94 + amplitude * 0.08);
            x = (((qx * Math.cos(turn) - qy * Math.sin(turn)) * scale * halfWidth) / span) * 0.65;
            y = (qx * Math.sin(turn) + qy * Math.cos(turn)) * scale * halfHeight * 0.65;
            z = -0.7 + travel * 1.3 + Math.sin(angle + phase) * 0.25;
          } else {
            // Fine transient trails accelerate away from the deck, then spiral
            // into the outer field. Their peaks and hue remain track-derived.
            const travel = (((u + beat / 16) % 1) + 1) % 1;
            const angle = (layer / 8) * Math.PI * 2 + phase + travel * 2.4;
            const radius = 0.2 + travel * 1.6;
            x = ((Math.cos(angle) * radius * halfWidth) / span) * 0.8;
            y = Math.sin(angle) * radius * halfHeight * 0.8;
            z = Math.sin(angle * 2 + travel * 4) * 0.7;
            x += Math.sin(u * 40 + phase) * amplitude * 0.07;
            y += Math.cos(u * 28 + phase) * amplitude * 0.07;
          }
          const breath = 1 + pulse * 0.055;
          out.set(
            x * span * enter * breath + origins[lane * 2]! * halfWidth * (1 - enter),
            y * enter * breath + origins[lane * 2 + 1]! * halfHeight * (1 - enter),
            z * enter - 0.45 * (1 - enter),
          );
        };
        for (let i = 0; i < count; i++) {
          const step = i % 256,
            strand = Math.floor(i / 256),
            family = Math.floor(strand / 8);
          const u = step / 255,
            offset = (lane * 256 + step) * 4;
          const amplitude = rgba[offset + 3]! / 255;
          const pulse = Math.exp(-((((beat - u * 8) % 1) + 1) % 1) * 5);
          path(center, u, strand, amplitude, pulse);
          path(ahead, u + 1 / 255, strand, amplitude, pulse);
          direction.subVectors(ahead, center);
          const length = direction.length();
          if (length > 0.000001) rotation.setFromUnitVectors(axis, direction.divideScalar(length));
          else rotation.identity();
          // Orient splats along the curve so they form a continuous surface,
          // instead of the previous detached feather-shaped particles.
          const thickness =
            family === 0 ? 0.0025 + amplitude * 0.002 : family === 1 ? 0.002 : 0.003;
          scales.set(
            family === 2 ? 0.008 + pulse * 0.012 : Math.min(0.035, Math.max(0.003, length * 0.65)),
            thickness,
            thickness * 0.65,
          );
          const accent = waveformAccent(
            [rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!],
            amplitude,
            pulse,
            family === 0 ? 1 : family === 1 ? 0.35 : 1,
          );
          color.setRGB(...accent);
          const tail = 1 - THREE.MathUtils.smoothstep(u, 0.94, 1);
          const ringTravel = ((((beat * 0.5 - (strand % 8)) / 8) % 1) + 1) % 1;
          const moteTravel = (((u + beat / 16) % 1) + 1) % 1;
          const hierarchy = family === 0 ? 1 : family === 1 ? 0.72 : 0.6 + phrase * 0.25;
          const pattern =
            family === 1
              ? Math.sin(ringTravel * Math.PI)
              : family === 2
                ? Math.sin(moteTravel * Math.PI) * (0.3 + amplitude * 0.7)
                : 1;
          packed.setSplat(
            i,
            center,
            scales,
            rotation,
            level * tail * hierarchy * pattern * (0.45 + amplitude * 0.3 + pulse * 0.45),
            color,
          );
        }
        packed.needsUpdate = true;
        mesh.version++;
      }
      renderer.render(scene, camera);
    },
  };
}
