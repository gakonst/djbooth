import * as THREE from "three/webgpu";
import { positionWorld, screenCoordinate, texture, uniform, uv, vec2, wgslFn } from "three/tsl";

// One continuous surface. All three decks enter the same deformation and ink field.
const sharedPosition = wgslFn(`
fn sharedPosition(st: vec2f, a0: vec4f, a1: vec4f, a2: vec4f,
                  m0: vec4f, m1: vec4f, m2: vec4f, clock: f32, aspect: f32) -> vec3f {
  let theta = st.x * 6.283185;
  let u = st.y;
  let levels = clamp(sqrt(max(vec3f(a0.x,a1.x,a2.x),vec3f(0.0))) * 1.6, vec3f(0.0),vec3f(1.0));
  let beats = vec3f(m0.w,m1.w,m2.w) * 6.283185;
  let pulses = pow(0.5 + 0.5 * cos(beats - u * 4.0), vec3f(6.0)) * levels;
  let low = dot(vec3f(a0.y,a1.y,a2.y), levels) / max(1.0, dot(levels,vec3f(1.0)));
  let mid = dot(vec3f(a0.z,a1.z,a2.z), levels) / max(1.0, dot(levels,vec3f(1.0)));
  let high = dot(vec3f(a0.w,a1.w,a2.w), levels) / max(1.0, dot(levels,vec3f(1.0)));
  let fold = sin(theta * 3.0 + clock * 0.13 + m0.x) * (0.18 + low * 0.25)
    + sin(theta * 5.0 - u * 3.0 - clock * 0.09 + m1.x) * mid * 0.19
    + sin(theta * 9.0 + u * 8.0 + m2.x) * high * 0.08;
  let push = dot(pulses, vec3f(0.10 + 0.07 * sin(theta * 2.0),
     0.10 + 0.07 * cos(theta * 3.0), 0.10 + 0.07 * sin(theta * 4.0 + 1.0)));
  let fx = dot(vec3f(m0.y,m1.y,m2.y), levels) * 0.18;
  let twist = theta + u * 0.75 + sin(clock * 0.09) * u * 0.28;
  let radius = 1.02 + u * 3.8 + (fold + push) * sin(u * 3.14159);
  let spread = max(0.45, pow(aspect,0.72));
  var p = vec3f(cos(twist) * radius * spread,
     sin(twist) * (radius * 0.83 + sin(theta * 2.0 + clock * 0.07) * u * 0.25),
     -1.05 + u * 0.70 + sin(theta * 3.0 + u * 2.0 + clock * 0.10) * (0.20 + u * 0.85));
  p.z += fold * 0.55 + push * sin(u * 3.14159) + fx * sin(theta * 6.0 + u * 5.0);
  // The opening drifts as part of the landscape, rather than orbiting each deck.
  p.x += sin(clock * 0.08) * u * 0.35;
  p.y += cos(theta + clock * 0.06) * u * 0.20;
  return p;
}`);

const sharedInk = wgslFn(`
fn sharedInk(st: vec2f, world: vec3f, pixel: vec2f,
             s0: vec4f, s1: vec4f, s2: vec4f, a0: vec4f, a1: vec4f, a2: vec4f,
             m0: vec4f, m1: vec4f, m2: vec4f, clock: f32) -> vec3f {
  let theta = st.x * 6.283185;
  let levels = clamp(sqrt(max(vec3f(a0.x,a1.x,a2.x),vec3f(0.0))) * 1.6, vec3f(0.0),vec3f(1.0));
  let field = 0.55 + 0.45 * sin(vec3f(theta * 2.0 + st.y * 6.0 + clock * 0.13,
       theta * 3.0 - st.y * 5.0 - clock * 0.11 + 2.1,
       theta * 2.0 - st.y * 9.0 + clock * 0.09 + 4.2));
  let influence = pow(field * levels, vec3f(3.0));
  let weights = influence / max(0.001,dot(influence,vec3f(1.0)));
  let hue0 = s0.rgb / max(0.015,max(s0.r,max(s0.g,s0.b)));
  let hue1 = s1.rgb / max(0.015,max(s1.r,max(s1.g,s1.b)));
  let hue2 = s2.rgb / max(0.015,max(s2.r,max(s2.g,s2.b)));
  let hue = hue0 * weights.x + hue1 * weights.y + hue2 * weights.z;
  let pulses = pow(0.5 + 0.5 * cos(vec3f(m0.w,m1.w,m2.w) * 6.283185 - st.y * 4.0),vec3f(6.0));
  let pulse = dot(pulses,weights);
  let level = min(1.0,dot(levels,vec3f(0.65)));
  let phase = st.y * 19.0 + sin(theta * 3.0 + clock * 0.08) * 0.24;
  let line = abs(sin(phase * 3.14159));
  let edge = smoothstep(0.025,0.025 + fwidth(phase) * 3.5,line);
  let colorMask = smoothstep(-0.25,0.25,sin(phase * 0.78 + theta * 2.0 - clock * 0.09));
  let ink = mix(vec3f(0.80,0.82,0.78),hue,colorMask * level);
  let normal = normalize(cross(dpdx(world),dpdy(world)));
  let light = 0.28 + 0.72 * abs(dot(normal,normalize(vec3f(-0.5,0.7,1.0))));
  let grain = fract(dot(floor(pixel),vec2f(0.75487766,0.56984029)));
  let shade = floor((light + grain * 0.065) * 10.0) / 10.0;
  let brightness = (0.04 + level * (0.46 + pulse * 0.32)) * (0.45 + shade * 0.55);
  return ink * brightness * mix(0.06,1.0,edge);
}`);

export async function createWebGPUBooth(host: HTMLCanvasElement) {
  const renderer = new THREE.WebGPURenderer({ alpha: true, antialias: true });
  const canvas = renderer.domElement;
  canvas.className = "booth-visuals webgpu-booth";
  canvas.style.zIndex = "3";
  canvas.setAttribute("aria-hidden", "true");
  renderer.setClearColor(0x000000, 0);
  try {
    await renderer.init();
    if (!(renderer.backend instanceof THREE.WebGPUBackend))
      throw new Error("This scene needs a WebGPU adapter.");
  } catch (error) {
    renderer.dispose();
    throw error;
  }
  canvas.dataset.renderer = "webgpu";
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 40);
  camera.position.z = 5.5;
  const clock = uniform(0),
    aspect = uniform(1);
  const waveformData = new Uint8Array(256 * 3 * 4);
  const waveform = new THREE.DataTexture(waveformData, 256, 3);
  waveform.minFilter = waveform.magFilter = THREE.LinearFilter;
  waveform.needsUpdate = true;
  const lanes = Array.from({ length: 3 }, () => ({
    audio: uniform(new THREE.Vector4()),
    controls: uniform(new THREE.Vector4()),
  }));
  const grid = new THREE.PlaneGeometry(1, 1, 512, 128);
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const signals = lanes.map((_, lane) =>
    texture(waveform, vec2(uv().y.mul(0.65), (lane + 0.5) / 3)),
  );
  const input = {
    st: uv(),
    clock,
    a0: lanes[0]!.audio,
    a1: lanes[1]!.audio,
    a2: lanes[2]!.audio,
    m0: lanes[0]!.controls,
    m1: lanes[1]!.controls,
    m2: lanes[2]!.controls,
  };
  material.positionNode = sharedPosition({ ...input, aspect });
  // The native WGSL function returns vec3f; the TS signature cannot infer source text.
  material.colorNode = sharedInk({
    ...input,
    world: positionWorld,
    pixel: screenCoordinate,
    s0: signals[0]!,
    s1: signals[1]!,
    s2: signals[2]!,
  }) as THREE.Node<"vec3">;
  const mesh = new THREE.Mesh(grid, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  // These depth-only planes let the original DOM hardware occlude the rear surface.
  const surface = new THREE.PlaneGeometry(1, 1);
  const depthMaterial = new THREE.MeshBasicNodeMaterial({ colorWrite: false });
  const occluders = Array.from(
    host.parentElement?.querySelectorAll<HTMLElement>(
      ".booth-grid > .cdj3000, .booth-grid > .djma9",
    ) ?? [],
  ).map((element) => {
    const plane = new THREE.Mesh(surface, depthMaterial);
    plane.renderOrder = -1;
    scene.add(plane);
    return { element, plane };
  });
  const resize = () => {
    const width = innerWidth,
      height = innerHeight;
    // Bound raster cost on 4K/Retina screens while keeping the hardware at native resolution.
    renderer.setPixelRatio(
      Math.min(devicePixelRatio, 1.5, Math.sqrt(3_686_400 / (width * height))),
    );
    renderer.setSize(width, height);
    aspect.value = camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const halfHeight = Math.tan(THREE.MathUtils.degToRad(24)) * camera.position.z;
    const halfWidth = halfHeight * camera.aspect;
    for (const { element, plane } of occluders) {
      const r = element.getBoundingClientRect();
      plane.position.set(
        (((r.left + r.width / 2) / width) * 2 - 1) * halfWidth,
        (1 - ((r.top + r.height / 2) / height) * 2) * halfHeight,
        0,
      );
      plane.scale.set((r.width / width) * halfWidth * 2, (r.height / height) * halfHeight * 2, 1);
    }
  };
  const observer = new ResizeObserver(resize);
  const booth = host.parentElement?.querySelector(".booth-grid");
  if (booth) observer.observe(booth);
  window.addEventListener("resize", resize);
  const dispose = () => {
    observer.disconnect();
    window.removeEventListener("resize", resize);
    material.dispose();
    grid.dispose();
    surface.dispose();
    depthMaterial.dispose();
    waveform.dispose();
    renderer.dispose();
    canvas.remove();
    host.style.visibility = "";
  };
  try {
    resize();
    await renderer.compileAsync(scene, camera);
    host.after(canvas);
    host.style.visibility = "hidden";
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    dispose,
    draw(time: number, rgba: Uint8Array, energy: Float32Array, motion: Float32Array) {
      clock.value = time;
      waveformData.set(rgba);
      waveform.needsUpdate = true;
      for (let i = 0; i < 3; i++) {
        lanes[i]!.audio.value.fromArray(energy, i * 4);
        lanes[i]!.controls.value.fromArray(motion, i * 4);
      }
      renderer.render(scene, camera);
    },
  };
}
