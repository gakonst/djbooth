import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { DEFAULT_VISUAL_LOOK, type VisualLook } from "./visual-presets.js";

/** Original procedural jungle runner scenery; no game assets are used. */
export async function createTempleRunBooth(host: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.domElement.className = "booth-visuals temple-run-booth";
  renderer.domElement.dataset.renderer = "three-temple-run";
  renderer.domElement.setAttribute("aria-hidden", "true");
  Object.assign(renderer.domElement.style, { zIndex: "1", pointerEvents: "none" });
  renderer.setClearColor(0x120a16);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x29132c, 0.017);
  const camera = new THREE.PerspectiveCamera(88, 1, 0.1, 180);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let look: VisualLook = { ...DEFAULT_VISUAL_LOOK };
  scene.add(new THREE.HemisphereLight(0xaaa0d4, 0x4a160d, 3));
  const sun = new THREE.DirectionalLight(0xffab65, 4);
  sun.position.set(-10, 24, -40);
  scene.add(sun);
  // Chipped masonry and carved grooves give the ruins more than flat block color.
  const surface = document.createElement("canvas");
  surface.width = surface.height = 256;
  const ctx = surface.getContext("2d")!;
  ctx.fillStyle = "#a8a08b";
  ctx.fillRect(0, 0, 256, 256);
  let seed = 71;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 3000; i++) {
    ctx.fillStyle = `rgba(${random() > 0.5 ? "25,17,10" : "244,224,182"},${random() * 0.24})`;
    ctx.fillRect(random() * 256, random() * 256, 1 + random() * 6, 1 + random() * 3);
  }
  ctx.strokeStyle = "#4a4438";
  ctx.lineWidth = 4;
  for (let i = 0; i < 4; i++) {
    ctx.strokeRect(4, i * 64 + 3, 248, 59);
    ctx.beginPath();
    ctx.moveTo(30 + i * 47, i * 64);
    ctx.lineTo(45 + i * 47, i * 64 + 23);
    ctx.lineTo(32 + i * 47, i * 64 + 50);
    ctx.stroke();
  }
  const stoneTexture = new THREE.CanvasTexture(surface);
  const stone = new THREE.MeshStandardMaterial({
    color: 0x9d8060,
    map: stoneTexture,
    bumpMap: stoneTexture,
    bumpScale: 0.14,
    roughness: 0.95,
  });
  const darkStone = new THREE.MeshStandardMaterial({
    color: 0x655459,
    map: stoneTexture,
    bumpMap: stoneTexture,
    bumpScale: 0.18,
    roughness: 1,
  });
  const moss = new THREE.MeshStandardMaterial({ color: 0x475326, roughness: 1 });
  const gold = new THREE.MeshStandardMaterial({
    color: 0xffcc54,
    emissive: 0xe68a15,
    emissiveIntensity: 0.6,
    metalness: 0.75,
    roughness: 0.3,
  });
  const fire = new THREE.MeshBasicMaterial({ color: 0xff6818 });
  const leaf = new THREE.MeshStandardMaterial({ color: 0x29202d, side: THREE.DoubleSide });
  const bone = new THREE.MeshStandardMaterial({ color: 0xe8d5ae, roughness: 0.8 });
  const black = new THREE.MeshBasicMaterial({ color: 0x100911 });
  const pumpkinMaterial = new THREE.MeshStandardMaterial({ color: 0xe65d0d, roughness: 0.75 });
  const ectoplasm = new THREE.MeshBasicMaterial({ color: 0xa8ff39 });
  const sphere = new THREE.SphereGeometry(1, 12, 8);
  const spikeGeometry = new THREE.ConeGeometry(0.17, 1.3, 5);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const coin = new THREE.TorusGeometry(0.27, 0.09, 6, 12);
  const flame = new THREE.OctahedronGeometry(0.27);
  const branch = new THREE.CylinderGeometry(0.09, 0.16, 1, 5);
  const leafGeometry = new THREE.ConeGeometry(1, 3, 5);
  const relicGeometry = new THREE.IcosahedronGeometry(0.75, 0);
  const segments: {
    root: THREE.Group;
    coins: THREE.Mesh[];
    flames: THREE.Mesh[];
    runes: THREE.Mesh[];
  }[] = [];
  const block = (
    parent: THREE.Group,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ) => {
    const mesh = new THREE.Mesh(box, material);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    parent.add(mesh);
    return mesh;
  };
  const skull = (parent: THREE.Group, x: number, y: number, z: number, scale: number) => {
    const head = new THREE.Group();
    head.position.set(x, y, z);
    head.scale.setScalar(scale);
    parent.add(head);
    const cranium = new THREE.Mesh(sphere, bone);
    cranium.scale.set(0.65, 0.73, 0.45);
    head.add(cranium);
    block(head, bone, 0, -0.6, 0.05, 0.85, 0.4, 0.6);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(sphere, black);
      eye.position.set(side * 0.27, 0.06, 0.4);
      eye.scale.set(0.23, 0.28, 0.1);
      head.add(eye);
      const glow = new THREE.Mesh(sphere, ectoplasm);
      glow.position.set(side * 0.27, 0.04, 0.49);
      glow.scale.setScalar(0.085);
      head.add(glow);
    }
    for (let t = 0; t < 5; t++) block(head, black, (t - 2) * 0.15, -0.61, 0.37, 0.045, 0.3, 0.04);
    return head;
  };
  const bats: THREE.Group[] = [];
  const sceneryGeometry: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 17; i++) {
    const root = new THREE.Group();
    scene.add(root);
    // Three lanes echo the three independent CDJ signals.
    const coins: THREE.Mesh[] = [],
      flames: THREE.Mesh[] = [],
      runes: THREE.Mesh[] = [];
    for (let lane = 0; lane < 3; lane++) {
      const x = (lane - 1) * 2.5;
      block(root, (i + lane) % 3 ? stone : darkStone, x, -0.3, 0, 2.43, 0.6, 5.85);
      const token = new THREE.Mesh(coin, gold);
      token.position.set(x, 1.1, 0);
      root.add(token);
      coins.push(token);
      const rune = block(root, gold, x, 8.8, 0.5, 0.35, 0.35, 0.12);
      rune.rotation.z = Math.PI / 4;
      runes.push(rune);
    }
    for (const side of [-1, 1]) {
      block(root, moss, side * 4.4, -0.1, 0, 0.8, 0.8, 6);
      block(root, darkStone, side * 6.2, 4.4, 0, 1.5, 9, 1.7);
      block(root, stone, side * 6.2, 8.6, 0, 2.3, 0.65, 2.3);
      block(root, stone, side * 6.2, 0.4, 0, 2.3, 0.8, 2.3);
      for (let rib = 0; rib < 4; rib++)
        block(root, moss, side * 6.2, 1.8 + rib * 1.7, 0.92, 1.6, 0.16, 0.1);
      block(root, darkStone, side * 4.6, 2.9, 0, 0.35, 0.35, 0.65);
      const torch = new THREE.Mesh(flame, fire);
      torch.position.set(side * 4.6, 3.4, 0);
      root.add(torch);
      flames.push(torch);
      const vine = new THREE.Mesh(branch, moss);
      vine.position.set(side * 5.4, 6.7, 0.9);
      vine.scale.y = 4.5;
      vine.rotation.z = side * 0.12;
      root.add(vine);
      skull(root, side * 6.2, 7.1, 1.15, 0.9);
      const pumpkin = new THREE.Group();
      pumpkin.position.set(side * 4.7, 0.7, 1.8);
      root.add(pumpkin);
      for (let rib = 0; rib < 7; rib++) {
        const angle = (rib * Math.PI * 2) / 7;
        const lobe = new THREE.Mesh(sphere, pumpkinMaterial);
        lobe.position.set(Math.cos(angle) * 0.3, 0, Math.sin(angle) * 0.3);
        lobe.scale.set(0.4, 0.55, 0.4);
        pumpkin.add(lobe);
      }
      block(pumpkin, moss, 0, 0.62, 0, 0.15, 0.3, 0.15);
      for (const eyeSide of [-1, 1]) {
        const eye = new THREE.Mesh(spikeGeometry, fire);
        eye.position.set(eyeSide * 0.25, 0.1, 0.61);
        eye.scale.set(1, 0.22, 0.3);
        pumpkin.add(eye);
      }
      block(pumpkin, fire, 0, -0.23, 0.65, 0.5, 0.1, 0.07);
      if (i % 3 === 0)
        for (let s = 0; s < 5; s++) {
          const spike = new THREE.Mesh(spikeGeometry, bone);
          spike.position.set(side * 3.8, 0.7, s - 2);
          root.add(spike);
        }
      for (let j = 0; j < 3; j++) {
        const tree = new THREE.Mesh(leafGeometry, leaf);
        tree.position.set(side * (9 + j * 3), 6 + j * 2, -j);
        tree.scale.set(3, 4 + j, 3);
        tree.rotation.z = side * 0.3;
        root.add(tree);
      }
    }
    block(root, stone, 0, 9.3, 0, 14.5, 1, 2);
    block(root, moss, 0, 10, 0, 12, 0.45, 2.3);
    if (i % 3 === 0) {
      skull(root, 0, 10, 1.2, 2);
      for (const side of [-1, 1]) {
        const tooth = new THREE.Mesh(spikeGeometry, bone);
        tooth.position.set(side * 1.6, 8.7, 1);
        tooth.rotation.z = Math.PI;
        tooth.scale.set(2, 1.6, 2);
        root.add(tooth);
      }
    }
    const bat = new THREE.Group();
    bat.position.set((i % 2 ? -1 : 1) * 4, 7.6, 2);
    root.add(bat);
    bats.push(bat);
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(leafGeometry, black);
      wing.scale.set(0.45, 0.3, 0.05);
      wing.rotation.z = (side * Math.PI) / 2;
      wing.position.x = side * 0.4;
      bat.add(wing);
    }
    // Batch static carvings, vegetation and pumpkins so high speed stays fluid.
    root.updateMatrixWorld(true);
    const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
    const staticMeshes: THREE.Mesh[] = [];
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
      if (
        coins.includes(object) ||
        flames.includes(object) ||
        runes.includes(object) ||
        object.parent === bat
      )
        return;
      const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
      const bucket = buckets.get(object.material) ?? [];
      bucket.push(geometry);
      buckets.set(object.material, bucket);
      staticMeshes.push(object);
    });
    for (const [material, geometries] of buckets) {
      const geometry = mergeGeometries(geometries);
      if (geometry) {
        root.add(new THREE.Mesh(geometry, material));
        sceneryGeometry.push(geometry);
      }
      geometries.forEach((item) => item.dispose());
    }
    staticMeshes.forEach((mesh) => mesh.removeFromParent());
    segments.push({ root, coins, flames, runes });
  }
  const relic = new THREE.Mesh(relicGeometry, gold);
  relic.position.set(0, 7, -65);
  relic.scale.setScalar(4);
  scene.add(relic);
  const idol = new THREE.Group();
  scene.add(idol);
  skull(idol, 0, 11, -76, 9);
  const lavaMaterial = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, beat: { value: 0 } },
    vertexShader: `varying vec3 world; void main(){vec4 p=modelMatrix*vec4(position,1.);world=p.xyz;gl_Position=projectionMatrix*viewMatrix*p;}`,
    fragmentShader: `varying vec3 world; uniform float time; uniform float beat;
      void main(){vec2 p=world.xz*.4;float flow=time*.35;
        float cracks=abs(sin(p.x+sin(p.y*.7+flow)*1.8)*sin(p.y*.8-flow+sin(p.x)));
        float glow=1.-smoothstep(.02,.16,cracks);
        vec3 color=mix(vec3(.06,.009,.014),vec3(1.,.22,.006),glow);
        color+=vec3(.6,.11,.004)*pow(glow,5.);color*=1.+beat*1.6;
        float fog=1.-exp(-length(world.xz)*.016);
        gl_FragColor=vec4(mix(color,vec3(.07,.025,.08),fog),1.);}`,
  });
  const abyss = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), lavaMaterial);
  abyss.rotation.x = -Math.PI / 2;
  abyss.position.set(0, -5, -60);
  scene.add(abyss);
  const motesGeometry = new THREE.BufferGeometry();
  const positions = new Float32Array(240 * 3);
  for (let i = 0; i < 240; i++) {
    positions[i * 3] = Math.sin(i * 23.71) * 17;
    positions[i * 3 + 1] = 1 + ((i * 7.13) % 14);
    positions[i * 3 + 2] = -((i * 13.17) % 100);
  }
  motesGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const motesMaterial = new THREE.PointsMaterial({
    color: 0xff8c21,
    size: 0.11,
    transparent: true,
    opacity: 0.75,
  });
  const motes = new THREE.Points(motesGeometry, motesMaterial);
  scene.add(motes);
  const streakPositions = new Float32Array(90 * 6);
  const streakGeometry = new THREE.BufferGeometry();
  streakGeometry.setAttribute("position", new THREE.BufferAttribute(streakPositions, 3));
  const streakMaterial = new THREE.LineBasicMaterial({
    color: 0xffa14a,
    transparent: true,
    opacity: 0.4,
  });
  const streaks = new THREE.LineSegments(streakGeometry, streakMaterial);
  scene.add(streaks);
  const waveGeometry = new THREE.TorusGeometry(5.1, 0.045, 4, 48);
  const waveMaterial = new THREE.MeshBasicMaterial({
    color: 0xff8b22,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const beatWaves = Array.from({ length: 6 }, () => {
    const wave = new THREE.Mesh(waveGeometry, waveMaterial);
    scene.add(wave);
    return wave;
  });
  let width = 0,
    height = 0,
    previous = 0,
    travel = 0,
    turn = 0,
    speed = 0,
    worldPulse = 0,
    musicalTime = 0,
    leader = 0,
    challenger = -1,
    challengeSeconds = 0;
  const lastBeats: (number | undefined)[] = [undefined, undefined, undefined];
  const beatRates = [0, 0, 0];
  const wrap = (value: number, length: number) => ((value % length) + length) % length;
  // Alternating eight-beat bends have zero velocity at each endpoint. There are
  // no frame-dependent choices; a seek always resolves to the same musical bend.
  const phraseTurn = (beat: number) => {
    const phrase = Math.floor(beat / 8);
    const direction = wrap(phrase, 2) === 0 ? 1 : -1;
    return -direction * Math.cos((wrap(beat, 8) / 8) * Math.PI);
  };
  const oldVisibility = host.style.visibility;
  host.after(renderer.domElement);
  host.style.visibility = "hidden";
  return {
    setLook(value: VisualLook) {
      look = { ...value };
    },
    draw(
      time: number,
      rgba: Uint8Array,
      energy: Float32Array,
      motion: Float32Array,
      _origins?: Float32Array,
      audibleLevels?: Float32Array,
    ) {
      const bounds = host.getBoundingClientRect();
      if (width !== bounds.width || height !== bounds.height) {
        width = bounds.width;
        height = bounds.height;
        renderer.setSize(Math.max(1, width), Math.max(1, height), false);
        camera.aspect = width / Math.max(1, height);
        camera.updateProjectionMatrix();
      }
      const dt = previous ? Math.min(0.1, Math.max(0, time - previous)) : 0;
      previous = time;
      const levels = [0, 1, 2].map((lane) => {
        // Use the actual program level, separate from the visual-only cue glow.
        const level = audibleLevels?.[lane] ?? Math.max(0, (energy[lane * 4] ?? 0) - 0.06);
        return Number.isFinite(level) ? Math.min(1, Math.sqrt(Math.max(0, level)) * 1.6) : 0;
      });
      const beats = [0, 1, 2].map((lane) => {
        const beat = motion[lane * 4 + 3] ?? 0;
        return Number.isFinite(beat) ? beat : 0;
      });
      const total = levels.reduce((sum, level) => sum + level, 0);
      const activity = Math.min(1, total / 2);
      const movement = reduced.matches ? 0 : look.motion;
      const follow = 1 - Math.exp(-dt * 8);
      // No master-deck flag is available here. Retain an audible leader through
      // small level fluctuations, requiring sustained dominance before handoff.
      const strongest = levels.reduce(
        (best, level, lane) => (level > levels[best]! ? lane : best),
        leader,
      );
      const competing = strongest !== leader && levels[strongest]! > levels[leader]! * 1.5 + 0.08;
      if (competing) {
        challengeSeconds = challenger === strongest ? challengeSeconds + dt : 0;
        challenger = strongest;
        if (levels[leader]! < 0.02 || challengeSeconds >= 0.5) {
          leader = strongest;
          challenger = -1;
          challengeSeconds = 0;
        }
      } else {
        challenger = -1;
        challengeSeconds = 0;
      }
      for (let lane = 0; lane < 3; lane++) {
        const beat = beats[lane]!;
        const delta = beat - (lastBeats[lane] ?? beat);
        lastBeats[lane] = beat;
        // Estimate tempo from the authoritative beat clock, rejecting seeks and
        // track changes instead of converting them into a burst of acceleration.
        const rate = dt > 0 ? delta / dt : 0;
        const valid = rate > 0 && rate <= 6 && delta < 0.5;
        beatRates[lane] = THREE.MathUtils.lerp(beatRates[lane]!, valid ? rate : 0, follow);
      }
      const drive = Math.min(1, levels[leader]! * 2);
      const targetTurn = phraseTurn(beats[leader]!) * drive;
      // An eight-beat launch/coast/brake/hold cycle stays locked to track time.
      // The last part of the phrase rests, ready for the next downbeat launch.
      const cycle = wrap(beats[leader]!, 8);
      const launch = THREE.MathUtils.smootherstep(cycle, 0, 1.5);
      const coast = 1 - THREE.MathUtils.smootherstep(cycle, 3.5, 5) * 0.35;
      const brake = 1 - THREE.MathUtils.smootherstep(cycle, 5, 6.25);
      const throttle = launch * coast * brake;
      const targetSpeed = beatRates[leader]! * (28 + activity * 20) * drive * throttle;
      turn = THREE.MathUtils.lerp(turn, targetTurn, 1 - Math.exp(-dt * 3));
      speed = THREE.MathUtils.lerp(
        speed,
        targetSpeed,
        1 - Math.exp(-dt * (targetSpeed > speed ? 6 : 10)),
      );
      if (targetSpeed < 0.01 && speed < 0.4) speed = 0;
      const pulse = beats.map((beat, lane) => Math.exp(-wrap(beat, 1) * 9) * levels[lane]!);
      const beatRunning = Math.min(1, beatRates[leader]! * 2);
      const targetPulse = Math.exp(-wrap(beats[leader]!, 1) * 4.5) * drive * beatRunning;
      worldPulse = THREE.MathUtils.lerp(
        worldPulse,
        targetPulse,
        1 - Math.exp(-dt * (targetPulse > worldPulse ? 30 : 12)),
      );
      const impact = worldPulse * Math.min(1.5, look.intensity);
      const physicalPulse = impact * (reduced.matches ? 0 : Math.min(1, movement));
      travel += dt * speed * movement;
      musicalTime += ((dt * speed) / 24) * movement;
      renderer.domElement.dataset.speed = (speed * movement).toFixed(1);
      renderer.domElement.dataset.driveState =
        speed < 0.4 || movement === 0
          ? "stopped"
          : cycle < 1.5
            ? "launch"
            : cycle < 3.5
              ? "surge"
              : cycle < 5
                ? "coast"
                : "braking";
      renderer.domElement.dataset.beatPulse = worldPulse.toFixed(3);
      for (let i = 0; i < segments.length; i++) {
        const section = segments[i]!;
        section.root.position.z = 10 - ((i * 6 - (travel % 102) + 102) % 102);
        const distance = 10 - section.root.position.z;
        section.root.position.x = turn * Math.pow(distance / 102, 2) * 18 * movement;
        section.root.rotation.y = Math.atan((-36 * turn * distance * movement) / (102 * 102));
        section.root.rotation.z = -turn * (distance / 102) * 0.014 * movement;
        // The entire course breathes together: masonry, skulls, trees and road.
        section.root.scale.set(1 + physicalPulse * 0.075, 1 + physicalPulse * 0.085, 1);
        for (let lane = 0; lane < 3; lane++) {
          const waveform = (rgba[(lane * 256 + ((i * 13) % 256)) * 4 + 3] ?? 0) / 255;
          const token = section.coins[lane]!;
          token.rotation.y = beats[lane]! * Math.PI * movement;
          token.position.y =
            1.25 +
            Math.sin(beats[lane]! * Math.PI * 2 + i) * levels[lane]! * 0.12 * movement +
            waveform * (energy[lane * 4] ?? 0) * 0.65;
          section.runes[lane]!.scale.setScalar(0.35 * (1 + (pulse[lane] ?? 0) * look.intensity));
        }
        for (let j = 0; j < section.flames.length; j++) {
          section.flames[j]!.scale.set(
            1,
            1.4 +
              (pulse[j * 2] ?? 0) * 1.5 +
              Math.sin(musicalTime * Math.PI * 4 + i) * activity * 0.15 * movement,
            1,
          );
        }
        const bat = bats[i]!;
        bat.position.x = Math.sin(musicalTime * Math.PI + i * 2) * 4.5 * movement;
        bat.position.y = 7.4 + Math.sin(musicalTime * Math.PI * 2 + i) * 0.8 * movement;
        bat.children.forEach((wing, side) => {
          wing.rotation.y =
            Math.sin(musicalTime * Math.PI * 8 + i) * (side ? -0.8 : 0.8) * movement;
        });
      }
      camera.position.set(turn * 1.4 * movement, 3.7, 13);
      camera.lookAt(turn * 6 * movement, 5.7, -48);
      camera.rotateZ(-turn * 0.022 * movement);
      const fov = THREE.MathUtils.lerp(
        camera.fov,
        88 + activity * 6 * movement + physicalPulse * 2.2,
        1 - Math.exp(-dt * 7),
      );
      if (Math.abs(camera.fov - fov) > 0.1) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      relic.rotation.y = musicalTime * 0.4;
      relic.position.y = 7 + Math.sin(musicalTime) * 0.4 * movement;
      relic.scale.setScalar(4 * (1 + physicalPulse * 0.22));
      gold.emissiveIntensity = 0.45 + activity * look.intensity + impact * 2.5;
      stone.emissive.setHex(0x70300c);
      stone.emissiveIntensity = impact * 0.45;
      darkStone.emissive.setHex(0x471752);
      darkStone.emissiveIntensity = impact * 0.65;
      ectoplasm.color.setRGB(0.45 + impact * 0.25, 0.75 + impact * 0.25, 0.08);
      sun.intensity = 4 + impact * 3;
      renderer.toneMappingExposure = 1 + impact * 0.13;
      lavaMaterial.uniforms.time!.value = musicalTime;
      lavaMaterial.uniforms.beat!.value = impact;
      waveMaterial.opacity = reduced.matches ? 0 : impact * 0.55;
      for (let i = 0; i < beatWaves.length; i++) {
        const wave = beatWaves[i]!;
        const distance = wrap(beats[leader]! * 14 + i * 17, 102);
        wave.position.set(turn * Math.pow(distance / 102, 2) * 18 * movement, 4.8, 10 - distance);
        wave.scale.setScalar(1 + physicalPulse * 0.08);
      }
      motesMaterial.size = 0.11 + impact * 0.12;
      motes.rotation.y = Math.sin(musicalTime * 0.1) * 0.03 * movement;
      for (let i = 0; i < 240; i++) {
        positions[i * 3 + 2] = 12 - ((i * 13.17 - ((travel * 1.4) % 110) + 110) % 110);
      }
      motesGeometry.attributes.position!.needsUpdate = true;
      for (let i = 0; i < 90; i++) {
        const angle = i * 2.39996;
        const z = 12 - ((i * 9.3 - ((travel * 1.7) % 85) + 85) % 85);
        const x = Math.cos(angle) * (7 + (i % 4) * 2);
        const y = 4 + Math.sin(angle) * (6 + (i % 3));
        streakPositions.set([x, y, z, x, y, z - 3 - activity * 5], i * 6);
      }
      streakGeometry.attributes.position!.needsUpdate = true;
      streakMaterial.opacity = reduced.matches ? 0 : 0.22 + activity * 0.25 + impact * 0.25;
      renderer.render(scene, camera);
    },
    dispose() {
      host.style.visibility = oldVisibility;
      renderer.domElement.remove();
      for (const geometry of [
        box,
        coin,
        flame,
        branch,
        leafGeometry,
        relicGeometry,
        motesGeometry,
        sphere,
        spikeGeometry,
        abyss.geometry,
        streakGeometry,
        waveGeometry,
      ])
        geometry.dispose();
      for (const material of [
        stone,
        darkStone,
        moss,
        gold,
        fire,
        leaf,
        motesMaterial,
        bone,
        black,
        pumpkinMaterial,
        ectoplasm,
        lavaMaterial,
        streakMaterial,
        waveMaterial,
      ])
        material.dispose();
      stoneTexture.dispose();
      sceneryGeometry.forEach((geometry) => geometry.dispose());
      renderer.dispose();
    },
  };
}
