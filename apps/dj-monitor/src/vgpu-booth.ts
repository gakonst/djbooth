import { effect, frame, init, sampler, surface, target, texture } from "vgpu";
import sculptureSource from "./shaders/prismatic-field.wgsl?raw";
import extractSource from "./shaders/bloom-extract.wgsl?raw";
import blurSource from "./shaders/bloom-blur.wgsl?raw";
import presentSource from "./shaders/prismatic-present.wgsl?raw";

/** Vercel vgpu renderer; consumes the same real, independent deck signals as the booth. */
export async function createVgpuBooth(host: HTMLCanvasElement) {
  const gpu = await init({ powerPreference: "high-performance", label: "DJ booth prism" });
  const canvas = document.createElement("canvas");
  canvas.className = "booth-visuals vgpu-booth";
  canvas.style.zIndex = "3";
  canvas.setAttribute("aria-hidden", "true");
  canvas.dataset.renderer = "vgpu";
  let disposed = false;
  let failure: Error | undefined;
  let observer: ResizeObserver | undefined;
  let resize = () => {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    window.removeEventListener("resize", resize);
    gpu.dispose();
    canvas.remove();
    host.style.visibility = "";
  };
  gpu.onError((error) => {
    failure = error;
  });
  void gpu.gpu.lost.then((info: { message: string }) => {
    if (!disposed) failure = new Error(`WebGPU device lost: ${info.message}`);
  });
  try {
    const output = surface(gpu, canvas, { autoResize: false, alphaMode: "premultiplied" });
    const hdr = target(gpu, { size: [1, 1], format: "rgba16float" });
    const bloomA = target(gpu, { size: [1, 1], format: "rgba16float" });
    const bloomB = target(gpu, { size: [1, 1], format: "rgba16float" });
    const linear = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    const waveform = texture(gpu, {
      kind: "2d",
      size: [256, 3],
      format: "rgba8unorm",
      usage: ["texture_binding", "copy_dst"],
    });
    const sculpture = effect(gpu, sculptureSource, { label: "shared-prismatic-field" });
    const extract = effect(gpu, extractSource, { label: "prism-bloom-extract" });
    const blurH = effect(gpu, blurSource, { label: "prism-bloom-horizontal" });
    const blurV = effect(gpu, blurSource, { label: "prism-bloom-vertical" });
    const present = effect(gpu, presentSource, { label: "prism-film-and-dither" });
    const scene = {
      resolution: [1, 1],
      time: 0,
      aspect: 1,
      audio0: [0, 0, 0, 0],
      audio1: [0, 0, 0, 0],
      audio2: [0, 0, 0, 0],
      motion0: [0, 0, 0, 0],
      motion1: [0, 0, 0, 0],
      motion2: [0, 0, 0, 0],
      booth: [0, 0, 0, 0],
      drive: [0, 0, 0, 0],
    };
    let pixelBudget = 850_000;
    const booth = host.parentElement?.querySelector<HTMLElement>(".booth-grid");
    resize = () => {
      const width = Math.max(1, host.clientWidth),
        height = Math.max(1, host.clientHeight);
      const dpr = Math.min(devicePixelRatio, 1.5, Math.sqrt(2_400_000 / (width * height)));
      output.resize([Math.round(width * dpr), Math.round(height * dpr)]);
      const scale = Math.min(dpr, Math.sqrt(pixelBudget / (width * height)));
      const size: [number, number] = [
        Math.max(1, Math.round(width * scale)),
        Math.max(1, Math.round(height * scale)),
      ];
      hdr.resize(size);
      const bloomSize: [number, number] = [
        Math.max(1, Math.ceil(size[0] / 4)),
        Math.max(1, Math.ceil(size[1] / 4)),
      ];
      bloomA.resize(bloomSize);
      bloomB.resize(bloomSize);
      const rects = Array.from(booth?.children ?? []).map((element) =>
        element.getBoundingClientRect(),
      );
      const hostRect = host.getBoundingClientRect();
      scene.booth = rects.length
        ? [
            (Math.min(...rects.map((r) => r.left)) - hostRect.left) / width,
            (Math.min(...rects.map((r) => r.top)) - hostRect.top) / height,
            (Math.max(...rects.map((r) => r.right)) - hostRect.left) / width,
            (Math.max(...rects.map((r) => r.bottom)) - hostRect.top) / height,
          ]
        : [0, 0, 0, 0];
      scene.resolution = size;
      scene.aspect = width / height;
      sculpture.set({ scene, waveforms: waveform, linear_sampler: linear });
      extract.set({
        source: hdr,
        linear_sampler: linear,
        params: { texel: hdr.texelSize, threshold: 0.7, padding: 0 },
      });
      blurH.set({
        source: bloomA,
        linear_sampler: linear,
        params: { direction: [bloomA.texelSize[0], 0], padding: [0, 0] },
      });
      blurV.set({
        source: bloomB,
        linear_sampler: linear,
        params: { direction: [0, bloomB.texelSize[1]], padding: [0, 0] },
      });
      present.set({
        source: hdr,
        bloom: bloomA,
        linear_sampler: linear,
        params: { booth: scene.booth, resolution: output.size, strength: 0.36, padding: 0 },
      });
      canvas.dataset.renderSize = size.join("×");
    };
    resize();
    // Await actual shader compilation before hiding the working fallback.
    gpu.gpu.pushErrorScope("validation");
    let compilationError: unknown;
    try {
      await Promise.all([
        sculpture.compile(hdr),
        extract.compile(bloomA),
        blurH.compile(bloomB),
        blurV.compile(bloomA),
        present.compile({ colors: [output.format] }),
      ]);
    } catch (error) {
      compilationError = error;
    }
    const validationError = await gpu.gpu.popErrorScope();
    if (compilationError) throw compilationError;
    if (validationError) throw new Error(validationError.message);
    if (failure) throw failure;
    host.after(canvas);
    host.style.visibility = "hidden";
    observer = new ResizeObserver(resize);
    observer.observe(host);
    if (booth) observer.observe(booth);
    window.addEventListener("resize", resize);
    let inFlight = 0,
      lastFrame = 0,
      elapsed = 0,
      frames = 0,
      diagnosticsAt = 0;
    return {
      dispose,
      draw(time: number, rgba: Uint8Array, energy: Float32Array, motion: Float32Array) {
        if (failure) throw failure;
        if (disposed || document.hidden || inFlight >= 2) return;
        const now = performance.now();
        const delta = now - lastFrame;
        lastFrame = now;
        // Integrate velocity rather than multiplying absolute time by changing audio levels.
        // That keeps acceleration continuous when a deck pauses, seeks, or closes its fader.
        const dt = Math.min(0.05, Math.max(0, delta / 1000));
        let mixLevel = 0,
          beatDrive = 0;
        for (let lane = 0; lane < 3; lane++) {
          const level = Math.min(1, Math.sqrt(Math.max(0, energy[lane * 4]!)) * 1.8);
          mixLevel += level;
          beatDrive +=
            level * Math.pow(0.5 + 0.5 * Math.cos(motion[lane * 4 + 3]! * Math.PI * 2), 8);
        }
        scene.drive[0]! += dt * (0.12 + mixLevel * 0.85 + beatDrive * 1.6);
        scene.drive[1] = Math.min(1, mixLevel / 2);
        scene.drive[2] = beatDrive / Math.max(1, mixLevel);
        scene.drive[3]! += dt * (0.06 + mixLevel * 0.045);
        if (delta > 0 && delta < 100) {
          elapsed += delta;
          frames++;
        }
        // Adapt only after sustained load; keep hardware and text at native resolution.
        if (frames >= 120) {
          const average = elapsed / frames;
          if (average > 22 && pixelBudget > 380_000) {
            pixelBudget *= 0.82;
            resize();
          } else if (average < 14 && pixelBudget < 850_000) {
            pixelBudget = Math.min(850_000, pixelBudget * 1.1);
            resize();
          }
          canvas.dataset.frameMs = average.toFixed(1);
          elapsed = 0;
          frames = 0;
        }
        scene.time = time;
        for (let i = 0; i < 4; i++) {
          scene.audio0[i] = energy[i]!;
          scene.audio1[i] = energy[i + 4]!;
          scene.audio2[i] = energy[i + 8]!;
          scene.motion0[i] = motion[i]!;
          scene.motion1[i] = motion[i + 4]!;
          scene.motion2[i] = motion[i + 8]!;
        }
        sculpture.set({ scene });
        gpu.gpu.queue.writeTexture(
          { texture: waveform.gpu },
          rgba as Uint8Array<ArrayBuffer>,
          { bytesPerRow: 1024 },
          [256, 3],
        );
        const submitted = frame(gpu, (f) => {
          f.pass(hdr, sculpture);
          f.pass(bloomA, extract);
          f.pass(bloomB, blurH);
          f.pass(bloomA, blurV);
          f.pass(output, present);
        });
        inFlight++;
        void submitted.done.finally(() => {
          inFlight--;
        });
        if (now - diagnosticsAt > 500) {
          canvas.dataset.levels = [energy[0], energy[4], energy[8]]
            .map((v) => v!.toFixed(3))
            .join(",");
          diagnosticsAt = now;
        }
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
