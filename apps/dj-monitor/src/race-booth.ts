import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { createRaceCourse, wrapRaceDistance } from "./race-course.js";
import { initialVisualLook, type VisualLook, type VisualTheme } from "./visual-presets.js";

import { advanceRaceGame, createRaceGame, CHECKPOINTS } from "./race-game.js";
import "./race-booth.css";

const THEMES: VisualTheme[] = ["halloween", "eighties", "y2k", "tech-house"];
const PALETTES = [
  [0xff862e, 0xb386ff, 0xe8ddbf],
  [0xff298f, 0x29eaff, 0xa75aff],
  [0xff8bd7, 0x8deaff, 0xdfbaff],
  [0xbaff4e, 0xe4ffef, 0x38eab2],
].map((palette) => palette.map((color) => new THREE.Color(color)));
const GATES = 44;
const ROAD_Y = -3.8;

/** One continuous course, with the existing looks as smoothly blended track environments. */
export async function createRaceBooth(host: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    powerPreference: "high-performance",
  });
  renderer.domElement.className = "booth-visuals race-booth";
  renderer.domElement.dataset.renderer = "three-race";
  renderer.domElement.setAttribute("aria-hidden", "true");
  Object.assign(renderer.domElement.style, { zIndex: "1", pointerEvents: "none" });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const scene = new THREE.Scene();
  const background = new THREE.Color(0x05030c);
  scene.background = background;
  const fog = new THREE.FogExp2(background, 0.014);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(82, 1, 0.12, 320);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xd9e8ff, 0x140828, 2));
  const light = new THREE.DirectionalLight(0xffffff, 4);
  light.position.set(-8, 12, 8);
  camera.add(light);
  camera.add(light.target);
  light.target.position.set(0, 0, -24);

  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.65, 0.5, 0.85);
  const output = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(bloom);
  composer.addPass(output);

  const course = createRaceCourse();
  // Integer stations per lap ensure that every recycled gate meets the same course seam.
  const stations = Math.round(course.length / 8);
  const spacing = course.length / stations;
  const drive = createRaceGame();
  let crowd = { active: false, energy: 0, steering: 0 };
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const offset = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const aheadRotation = new THREE.Quaternion();
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const signal = new THREE.Color();
  const tint = new THREE.Color();
  const white = new THREE.Color(0xffffff);
  const laneColors = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
  const levels = [0, 0, 0];
  const pulses = [0, 0, 0];
  const weights = [0, 1, 0, 0];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let target = initialVisualLook("race");
  const look = { ...target };
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const instancedMeshes: THREE.InstancedMesh[] = [];

  function instances<G extends THREE.BufferGeometry, M extends THREE.Material>(
    geometry: G,
    material: M,
    count: number,
  ) {
    geometries.add(geometry);
    materials.add(material);
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    instancedMeshes.push(mesh);
    scene.add(mesh);
    return mesh;
  }
  function glowMaterial() {
    return new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
  }

  // Shared procedural hull pieces: swept wings, split engines and an amber canopy.
  const hullGeometry = new THREE.ConeGeometry(0.7, 3.5, 4);
  hullGeometry.rotateX(-Math.PI / 2);
  const wingGeometry = new THREE.BoxGeometry(1, 1, 1);
  const canopyGeometry = new THREE.SphereGeometry(0.48, 4, 3);
  const exhaustGeometry = new THREE.ConeGeometry(0.22, 1.7, 8);
  exhaustGeometry.rotateX(Math.PI / 2);
  [hullGeometry, wingGeometry, canopyGeometry, exhaustGeometry].forEach((g) => geometries.add(g));
  const engineMaterial = new THREE.MeshBasicMaterial({ color: 0x8af9ff });
  const canopyMaterial = new THREE.MeshPhongMaterial({
    color: 0x713611,
    emissive: 0x2a1004,
    flatShading: true,
    shininess: 100,
  });
  materials.add(engineMaterial);
  materials.add(canopyMaterial);
  function ship(paint: number) {
    const group = new THREE.Group();
    const hullMaterial = new THREE.MeshPhongMaterial({
      color: paint,
      shininess: 100,
      specular: 0x41525d,
      flatShading: true,
    });
    materials.add(hullMaterial);
    const hull = new THREE.Mesh(hullGeometry, hullMaterial);
    hull.scale.set(0.8, 0.55, 1);
    group.add(hull);
    const canopy = new THREE.Mesh(canopyGeometry, canopyMaterial);
    canopy.position.set(0, 0.3, -0.35);
    canopy.scale.set(0.65, 0.65, 1.45);
    group.add(canopy);
    const flames: THREE.Mesh[] = [];
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(wingGeometry, hullMaterial);
      wing.position.set(side * 0.85, -0.08, 0.45);
      wing.scale.set(1.6, 0.12, 1.15);
      wing.rotation.y = side * -0.45;
      group.add(wing);
      const engine = new THREE.Mesh(wingGeometry, hullMaterial);
      engine.position.set(side * 1.25, 0, 0.7);
      engine.scale.set(0.36, 0.36, 1.7);
      group.add(engine);
      const trim = new THREE.Mesh(wingGeometry, engineMaterial);
      trim.position.set(side * 1.25, 0.19, 0.7);
      trim.scale.set(0.08, 0.025, 1.2);
      group.add(trim);
      const flame = new THREE.Mesh(exhaustGeometry, engineMaterial);
      flame.position.set(side * 1.25, 0, 2);
      group.add(flame);
      flames.push(flame);
    }
    scene.add(group);
    return { group, flames };
  }
  const player = ship(0x2e5265);
  const rivals = [ship(0xe35081), ship(0x98ef54), ship(0xb68aff)];
  // Distant stars and faceted, wireframe asteroids evoke vector arcade cabinets.
  const skyGeometry = new THREE.BufferGeometry();
  const skyPositions = new Float32Array(480 * 3);
  for (let i = 0; i < 480; i++) {
    const y = 1 - (i / 479) * 2;
    const r = Math.sqrt(1 - y * y);
    skyPositions.set(
      [Math.cos(i * 2.39996) * r * 260, y * 260, Math.sin(i * 2.39996) * r * 260],
      i * 3,
    );
  }
  skyGeometry.setAttribute("position", new THREE.BufferAttribute(skyPositions, 3));
  const skyMaterial = new THREE.PointsMaterial({
    color: 0x88aaff,
    size: 1.5,
    sizeAttenuation: false,
    fog: false,
  });
  const sky = new THREE.Points(skyGeometry, skyMaterial);
  geometries.add(skyGeometry);
  materials.add(skyMaterial);
  scene.add(sky);
  const asteroids = instances(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true }),
    GATES * 2,
  );
  const checkpointMaterial = glowMaterial();
  const checkpoints = instances(new THREE.TorusGeometry(7.1, 0.2, 5, 4), checkpointMaterial, 3);
  const checkpointFlags = instances(new THREE.BoxGeometry(0.9, 0.55, 0.12), glowMaterial(), 24);
  const hud = document.createElement("div");
  hud.className = "race-hud";
  hud.setAttribute("aria-label", "Space race telemetry");
  hud.innerHTML =
    '<span class="race-title"><small>1UP · AUDIO + CROWD</small><b>SPACE RACE \'86</b></span><span><small>Speed</small><b></b></span><span><small>Position</small><b></b></span><span><small>Lap / gate</small><b></b></span><span><small>Beat boost</small><b></b></span>';
  const hudValues = hud.querySelectorAll("b");
  let lastHud = -1;

  const circle = new THREE.TorusGeometry(8.8, 0.075, 5, 80);
  const octagon = new THREE.TorusGeometry(8.8, 0.065, 4, 8);
  const chrome = new THREE.TorusGeometry(8.8, 0.22, 8, 80);
  const square = new THREE.TorusGeometry(9.6, 0.09, 4, 4);
  const gateMeshes = [circle, octagon, chrome, square].map((geometry, theme) =>
    instances(
      geometry,
      theme === 2
        ? new THREE.MeshPhongMaterial({
            color: 0xffffff,
            specular: 0xffffff,
            shininess: 120,
            transparent: true,
          })
        : glowMaterial(),
      GATES,
    ),
  );
  const halos = instances(circle, glowMaterial(), GATES);
  const bar = new THREE.BoxGeometry(1, 1, 1);
  const sleepers = instances(bar, glowMaterial(), GATES * 2);
  const lamps = instances(new THREE.OctahedronGeometry(0.5), glowMaterial(), GATES * 2);

  // The road and its rails are actual closed ribbons, not a scrolling screen texture.
  function ribbon(x: number, y: number, width: number, material: THREE.Material) {
    const vertices: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= 1024; i++) {
      course.sample((i / 1024) * course.length, position, rotation);
      for (const side of [-1, 1]) {
        offset
          .set(x + side * width * 0.5, y, 0)
          .applyQuaternion(rotation)
          .add(position);
        vertices.push(offset.x, offset.y, offset.z);
      }
      if (i < 1024) {
        const j = i * 2;
        indices.push(j, j + 1, j + 2, j + 1, j + 3, j + 2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometries.add(geometry);
    materials.add(material);
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    return mesh;
  }
  const roadMaterial = new THREE.MeshPhongMaterial({
    color: 0x100c22,
    specular: 0x2a2641,
    shininess: 75,
    side: THREE.DoubleSide,
  });
  ribbon(0, ROAD_Y, 12, roadMaterial);
  const railMaterials = [glowMaterial(), glowMaterial(), glowMaterial()];
  for (const x of [-3.9, 0, 3.9]) ribbon(x, ROAD_Y + 0.025, 0.025, railMaterials[2]!);
  for (const side of [-1, 1]) {
    ribbon(side * 5.85, ROAD_Y + 0.035, 0.12, railMaterials[0]!);
    ribbon(side * 6.05, ROAD_Y + 0.8, 0.045, railMaterials[1]!);
    ribbon(side * 1.95, ROAD_Y + 0.025, 0.035, railMaterials[2]!);
  }

  const starShape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const radius = i % 2 ? 0.42 : 1;
    if (i === 0) starShape.moveTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    else starShape.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
  starShape.closePath();
  const stars = instances(
    new THREE.ExtrudeGeometry(starShape, {
      depth: 0.25,
      bevelEnabled: true,
      bevelThickness: 0.1,
      bevelSize: 0.08,
      bevelSegments: 1,
      steps: 1,
    }),
    new THREE.MeshPhongMaterial({
      color: 0xe9c7ef,
      specular: 0xffffff,
      shininess: 110,
      transparent: true,
    }),
    GATES * 2,
  );
  const pumpkins = instances(
    new THREE.SphereGeometry(0.75, 12, 8),
    new THREE.MeshPhongMaterial({ color: 0xff6d12, shininess: 35, transparent: true }),
    GATES * 2,
  );
  const eyes = instances(new THREE.ConeGeometry(0.16, 0.28, 3), glowMaterial(), GATES * 4);
  const pylons = instances(bar, glowMaterial(), GATES * 2);

  // A distant banded sunset carries the 80s motif above the racing line.
  const sunsetMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { strength: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main() { vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `varying vec2 vUv; uniform float strength;
      void main() {
        vec2 p=vUv*2.-1.; float r=length(p);
        float disc=1.-smoothstep(.96,1.,r);
        float bands=mix(step(.28,fract(vUv.y*15.)),1.,smoothstep(.48,.65,vUv.y));
        vec3 color=mix(vec3(1.,.04,.25),vec3(1.,.63,.07),vUv.y)*1.5;
        gl_FragColor=vec4(color,disc*bands*strength);
      }`,
  });
  const sunsetGeometry = new THREE.PlaneGeometry(120, 120);
  geometries.add(sunsetGeometry);
  materials.add(sunsetMaterial);
  const sunset = new THREE.Mesh(sunsetGeometry, sunsetMaterial);
  sunset.position.set(0, 73, -270);
  camera.add(sunset);

  // Small, deterministic roadside streaks supply parallax without particle haze.
  const streaks = instances(bar, glowMaterial(), 84);
  const baseBackgrounds = [0x09040e, 0x08031a, 0x10091d, 0x020b09].map(
    (value) => new THREE.Color(value),
  );
  const oldVisibility = host.style.visibility;
  let previousTime: number | undefined;
  let width = 0;
  let height = 0;
  let pixelRatio = 0;
  let disposed = false;
  let contextLost = false;
  const onContextLost = (event: Event) => {
    event.preventDefault();
    contextLost = true;
  };
  renderer.domElement.addEventListener("webglcontextlost", onContextLost);

  function dispose() {
    if (disposed) return;
    disposed = true;
    renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
    renderer.domElement.remove();
    hud.remove();
    scene.clear();
    host.style.visibility = oldVisibility;
    instancedMeshes.forEach((mesh) => mesh.dispose());
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    bloom.dispose();
    output.dispose();
    renderPass.dispose();
    composer.dispose();
    renderer.dispose();
  }

  // Publish the replacement canvas only once its shaders are ready. Failed initialization
  // leaves the host canvas available to BoothVisuals' existing line fallback.
  try {
    await renderer.compileAsync(scene, camera);
  } catch (error) {
    dispose();
    throw error;
  }
  host.after(renderer.domElement, hud);
  host.style.visibility = "hidden";

  return {
    setCrowdMotion(input: { active: boolean; energy: number; steering: number }) {
      crowd = { ...input };
    },
    setLook(next: VisualLook) {
      const bounded = (value: number, min: number, max: number, fallback: number) =>
        Number.isFinite(value) ? THREE.MathUtils.clamp(value, min, max) : fallback;
      target = {
        theme: THEMES.includes(next.theme) ? next.theme : target.theme,
        intensity: bounded(next.intensity, 0, 2, target.intensity),
        motion: bounded(next.motion, 0, 2, target.motion),
        density: bounded(next.density, 0.1, 1, target.density),
        halloween: bounded(next.halloween, 0, 1, target.halloween),
      };
    },
    draw(time: number, rgba: Uint8Array, energy: Float32Array, motion: Float32Array) {
      if (disposed) return;
      if (contextLost) throw new Error("Racetrack graphics context lost");
      const bounds = host.getBoundingClientRect();
      const w = Math.max(1, bounds.width);
      const h = Math.max(1, bounds.height);
      // Keep the full-screen bloom within a 1.6 megapixel budget; the DOM stays native.
      const ratio = Math.min(devicePixelRatio, 1.5, Math.sqrt(1_600_000 / (w * h)));
      if (width !== w || height !== h || pixelRatio !== ratio) {
        width = w;
        height = h;
        pixelRatio = ratio;
        renderer.setPixelRatio(ratio);
        renderer.setSize(w, h, false);
        composer.setPixelRatio(ratio);
        composer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      const dt = previousTime === undefined ? 0 : Math.min(0.05, Math.max(0, time - previousTime));
      previousTime = time;
      const blend = 1 - Math.exp(-dt * 3);
      for (const key of ["intensity", "motion", "density", "halloween"] as const)
        look[key] += (target[key] - look[key]) * blend;
      for (let i = 0; i < THEMES.length; i++)
        weights[i]! += ((THEMES[i] === target.theme ? 1 : 0) - weights[i]!) * blend;

      let activity = 0;
      let beat = 0;
      for (let lane = 0; lane < 3; lane++) {
        const level = THREE.MathUtils.clamp(
          Math.sqrt(Math.max(0, energy[lane * 4] ?? 0)) * 1.5,
          0,
          1,
        );
        levels[lane] = level;
        const phase = motion[lane * 4 + 3] ?? 0;
        pulses[lane] = Math.exp(-wrapRaceDistance(phase, 1) * 8) * level;
        activity += level / 3;
        // One audible deck must be able to launch a charged boost on its own beat.
        beat = Math.max(beat, pulses[lane]!);
        laneColors[lane]!.setRGB(0, 0, 0);
        for (let theme = 0; theme < THEMES.length; theme++) {
          color.copy(PALETTES[theme]![lane]!).multiplyScalar(weights[theme]!);
          laneColors[lane]!.add(color);
        }
      }
      advanceRaceGame(drive, dt, course.length, {
        motion: target.motion === 0 ? 0 : look.motion,
        activity,
        beat,
        reducedMotion: reduced.matches,
        crowd,
      });
      const travel = drive.distance;
      const t = drive.clock;
      const moving = !reduced.matches && target.motion > 0;
      const cameraDistance = travel - 10;
      // Aim down the road so the player sits near 65% of the viewport, above the
      // bottom hardware overlay. The track and opponents remain in world space.
      course.sample(cameraDistance, position, rotation);
      camera.position
        .copy(position)
        .add(offset.set(drive.lane * 0.35, 1.5, 0).applyQuaternion(rotation));
      course.sample(travel + 24, ahead, aheadRotation);
      ahead.add(offset.set(drive.lane * 0.25, -5.5, 0).applyQuaternion(aheadRotation));
      camera.up.set(0, 1, 0).applyQuaternion(rotation);
      camera.lookAt(ahead);
      sky.position.copy(camera.position);
      const fov = 72 + (reduced.matches ? 0 : drive.boost > 0 ? 4 : 0);
      camera.fov += (fov - camera.fov) * blend;
      camera.updateProjectionMatrix();
      function placeShip(vessel: typeof player, distance: number, lane: number, isPlayer: boolean) {
        course.sample(distance, position, rotation);
        vessel.group.position
          .copy(position)
          .add(offset.set(lane, ROAD_Y + 1.1, 0).applyQuaternion(rotation));
        vessel.group.quaternion.copy(rotation);
        if (!reduced.matches && target.motion > 0) {
          vessel.group.rotateZ(isPlayer ? -drive.lane * 0.055 : Math.sin(t + lane) * 0.04);
          vessel.group.position.add(
            offset
              .set(0, Math.sin(t * 3 + lane) * 0.06 * (1 + drive.crowdEnergy), 0)
              .applyQuaternion(rotation),
          );
        }
        for (const flame of vessel.flames)
          flame.scale.z =
            reduced.matches || target.motion === 0
              ? 0.6
              : 0.8 + activity * 0.5 + (isPlayer && drive.boost > 0 ? 1.3 : 0);
      }
      placeShip(player, travel, drive.lane, true);
      for (let i = 0; i < rivals.length; i++) {
        const rival = drive.rivals[i]!;
        const relative =
          wrapRaceDistance(rival.distance - travel + course.length / 2, course.length) -
          course.length / 2;
        rivals[i]!.group.visible = relative > -35 && relative < 260;
        if (rivals[i]!.group.visible) placeShip(rivals[i]!, rival.distance, rival.lane, false);
      }
      // Retain a crossed gate until the chase camera and its near field clear it.
      const firstCheckpoint = Math.floor((cameraDistance - 8) / (course.length / CHECKPOINTS)) + 1;
      for (let i = 0; i < 3; i++) {
        const number = firstCheckpoint + i;
        course.sample((number * course.length) / CHECKPOINTS, position, rotation);
        dummy.position.copy(position);
        dummy.quaternion.copy(rotation);
        dummy.rotateZ(Math.PI / 4);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        checkpoints.setMatrixAt(i, dummy.matrix);
        checkpoints.setColorAt(i, color.setHex(number % CHECKPOINTS === 0 ? 0xffffff : 0xffb64f));
        for (let j = 0; j < 8; j++) {
          dummy.position
            .copy(position)
            .add(offset.set((j - 3.5) * 0.9, 4.8, 0).applyQuaternion(rotation));
          dummy.quaternion.copy(rotation);
          dummy.updateMatrix();
          checkpointFlags.setMatrixAt(i * 8 + j, dummy.matrix);
          checkpointFlags.setColorAt(i * 8 + j, color.setHex(j % 2 ? 0x07101c : 0xffffff));
        }
      }
      if (time - lastHud > 0.1 || lastHud < 0) {
        lastHud = time;
        hudValues[1]!.textContent = `${Math.round(drive.speed * 3.6)} km/h`;
        hudValues[2]!.textContent = `${drive.place} / 4`;
        hudValues[3]!.textContent = `${drive.lap} / ${(drive.checkpoints % CHECKPOINTS) + 1} of ${CHECKPOINTS}`;
        hudValues[4]!.textContent =
          reduced.matches || target.motion === 0
            ? "PAUSED"
            : drive.boost > 0
              ? "BOOST!"
              : `${Math.round(drive.charge * 100)}%`;
        hud.dataset.boost = String(drive.boost > 0 && !reduced.matches && target.motion > 0);
      }
      background.setRGB(0, 0, 0);
      for (let theme = 0; theme < THEMES.length; theme++)
        background.add(color.copy(baseBackgrounds[theme]!).multiplyScalar(weights[theme]!));
      fog.color.copy(background);
      bloom.strength = 0.45 + look.intensity * 0.2;
      roadMaterial.color.copy(background).multiplyScalar(2.5);
      for (let lane = 0; lane < 3; lane++) {
        railMaterials[lane]!.color.copy(laneColors[lane]!).multiplyScalar(
          1.2 + levels[lane]! * look.intensity,
        );
        railMaterials[lane]!.opacity = Math.min(1, look.intensity);
      }
      sunsetMaterial.uniforms.strength!.value = weights[1]! * Math.min(1, look.intensity);
      sunset.visible = weights[1]! > 0.002;

      const firstStation = Math.floor(travel / spacing) - 2;
      for (let theme = 0; theme < THEMES.length; theme++) {
        const mesh = gateMeshes[theme]!;
        mesh.visible = weights[theme]! > 0.002;
        mesh.material.opacity = weights[theme]! * Math.min(1, look.intensity) * 0.22;
      }
      halos.material.opacity = look.intensity * 0.05;
      sleepers.material.opacity = look.intensity * (0.22 + weights[1]! * 0.25);
      lamps.material.opacity = look.intensity * 0.6;
      pumpkins.material.opacity = weights[0]! * look.halloween * Math.min(1, look.intensity);
      eyes.material.opacity = pumpkins.material.opacity;
      pumpkins.visible = eyes.visible = pumpkins.material.opacity > 0.002;
      stars.material.opacity = weights[2]! * Math.min(1, look.intensity);
      stars.visible = stars.material.opacity > 0.002;
      pylons.material.opacity = weights[3]! * look.intensity * 0.6;
      pylons.visible = pylons.material.opacity > 0.002;
      asteroids.material.opacity = weights[1]! * 0.55 * Math.min(1, look.intensity);
      asteroids.visible = asteroids.material.opacity > 0.002;

      for (let i = 0; i < GATES; i++) {
        const station = firstStation + i;
        const id = wrapRaceDistance(station, stations);
        const lane = id % 3;
        const level = levels[lane]!;
        const pulse = pulses[lane]!;
        const envelopeIndex = (lane * 256 + Math.round((i / (GATES - 1)) * 255)) * 4;
        const amplitude = (rgba[envelopeIndex + 3] ?? 0) / 255;
        const geometrySignal = moving ? amplitude * level : 0;
        signal.setRGB(
          (rgba[envelopeIndex] ?? 0) / 255,
          (rgba[envelopeIndex + 1] ?? 0) / 255,
          (rgba[envelopeIndex + 2] ?? 0) / 255,
          THREE.SRGBColorSpace,
        );
        const distance = station * spacing;
        course.sample(distance, position, rotation);
        const relative = distance - travel;
        const fade = 1 - THREE.MathUtils.smoothstep(relative, 200, 300);
        // Density thins distant gates by their stable station IDs, retaining nearby guidance.
        const density =
          1 - THREE.MathUtils.smoothstep(((id * 17) % 31) / 31, look.density - 0.12, look.density);
        const presence = fade * Math.max(density, 1 - THREE.MathUtils.smoothstep(relative, 18, 48));
        const pulseScale = moving ? 1 + pulse * 0.025 * look.intensity : 1;
        for (let theme = 0; theme < THEMES.length; theme++) {
          const mesh = gateMeshes[theme]!;
          if (!mesh.visible) continue;
          dummy.position.copy(position);
          dummy.quaternion.copy(rotation);
          if (theme === 1) dummy.rotateZ(Math.PI / 8);
          if (theme === 3) dummy.rotateZ(Math.PI / 4);
          dummy.scale.set(pulseScale, pulseScale * (theme === 2 ? 0.8 : 1), 1);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          color.copy(PALETTES[theme]![lane]!).lerp(signal, level * amplitude * 0.45);
          color.multiplyScalar(presence * (1.3 + level * 0.9 + pulse * look.intensity));
          mesh.setColorAt(i, color);
        }
        dummy.position.copy(position);
        dummy.quaternion.copy(rotation);
        dummy.scale.set(1.025, 1.025, 1);
        dummy.updateMatrix();
        halos.setMatrixAt(i, dummy.matrix);
        tint.copy(laneColors[lane]!).lerp(signal, level * amplitude * 0.45);
        halos.setColorAt(i, color.copy(tint).multiplyScalar(presence));

        for (let side = 0; side < 2; side++) {
          const sign = side === 0 ? -1 : 1;
          const n = i * 2 + side;
          dummy.quaternion.copy(rotation);
          dummy.position
            .copy(position)
            .add(offset.set(sign * 3, ROAD_Y + 0.04, 0).applyQuaternion(rotation));
          dummy.scale.set(5.7, 0.025, 0.06);
          dummy.updateMatrix();
          sleepers.setMatrixAt(n, dummy.matrix);
          sleepers.setColorAt(n, color.copy(tint).multiplyScalar(fade));
          dummy.position
            .copy(position)
            .add(offset.set(sign * 6.1, ROAD_Y + 1, 0).applyQuaternion(rotation));
          dummy.scale.set(0.25, 1.2 + geometrySignal * 2, 0.3);
          dummy.updateMatrix();
          lamps.setMatrixAt(n, dummy.matrix);
          lamps.setColorAt(n, color.copy(tint).multiplyScalar(fade * (1.2 + pulse)));

          dummy.position
            .copy(position)
            .add(offset.set(sign * 7, -2.7, 0).applyQuaternion(rotation));
          dummy.scale.set(1.05, 0.8, 0.85);
          dummy.updateMatrix();
          pumpkins.setMatrixAt(n, dummy.matrix);
          pumpkins.setColorAt(n, color.setScalar(fade * density));
          for (let eye = 0; eye < 2; eye++) {
            dummy.position
              .copy(position)
              .add(
                offset.set(sign * 7 + (eye ? 0.25 : -0.25), -2.55, 0.62).applyQuaternion(rotation),
              );
            dummy.scale.setScalar(1);
            dummy.updateMatrix();
            eyes.setMatrixAt(n * 2 + eye, dummy.matrix);
            eyes.setColorAt(
              n * 2 + eye,
              color.setRGB(2.2, 1.5, 0.15).multiplyScalar(fade * density),
            );
          }
          dummy.position
            .copy(position)
            .add(offset.set(sign * 7.6, 1.6, 0).applyQuaternion(rotation));
          dummy.rotateY(t * 0.65 + id);
          dummy.rotateZ(sign * 0.3);
          dummy.scale.setScalar(0.9 + geometrySignal * 0.4);
          dummy.updateMatrix();
          stars.setMatrixAt(n, dummy.matrix);
          stars.setColorAt(
            n,
            color
              .copy(tint)
              .lerp(white, 0.65)
              .multiplyScalar(fade * density),
          );
          dummy.quaternion.copy(rotation);
          dummy.position.copy(position).add(offset.set(sign * 6.8, 0, 0).applyQuaternion(rotation));
          dummy.scale.set(0.075, 6 + geometrySignal * 3, 0.075);
          dummy.updateMatrix();
          pylons.setMatrixAt(n, dummy.matrix);
          pylons.setColorAt(n, color.copy(tint).multiplyScalar(presence));
          dummy.quaternion.copy(rotation);
          dummy.position
            .copy(position)
            .add(
              offset
                .set(sign * (17 + (id % 4) * 5), -1 + ((id * 7) % 11), 0)
                .applyQuaternion(rotation),
            );
          dummy.rotateY(t * 0.08 + id);
          dummy.rotateZ(id * 0.73);
          dummy.scale.setScalar(1.5 + (id % 4));
          dummy.updateMatrix();
          asteroids.setMatrixAt(n, dummy.matrix);
          asteroids.setColorAt(n, color.setHex(side ? 0x7c43b8 : 0x286cba).multiplyScalar(fade));
        }
      }
      streaks.material.opacity = reduced.matches
        ? 0
        : look.intensity * Math.min(0.5, drive.speed / 150);
      streaks.count = Math.round(84 * look.density);
      for (let i = 0; i < streaks.count; i++) {
        const distance = Math.floor(travel / 160) * 160 + ((i * 47.13) % 160);
        const aheadDistance = travel + wrapRaceDistance(distance - travel, 160);
        course.sample(aheadDistance, position, rotation);
        const angle = i * 2.39996;
        offset.set(Math.cos(angle) * 13, Math.sin(angle) * 10, 0).applyQuaternion(rotation);
        dummy.position.copy(position).add(offset);
        dummy.quaternion.copy(rotation);
        dummy.scale.set(0.018, 0.018, 1.5 + drive.speed * 0.035);
        dummy.updateMatrix();
        streaks.setMatrixAt(i, dummy.matrix);
        streaks.setColorAt(i, laneColors[i % 3]!);
      }
      for (const mesh of instancedMeshes) {
        if (!mesh.visible) continue;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      renderer.domElement.dataset.theme = target.theme;
      composer.render(dt);
    },
    dispose,
  };
}
