import {
  FLAT_WAVEFORM_BANDS,
  shapeWaveformSignal,
  waveformBeat,
  waveformSignal,
} from "../../dj-monitor/src/waveform-signal.js";
import type { PreviewDeck } from "./decks.js";
import { sceneInfo, type MusicLane, type SceneEngine } from "./scenes.js";
import type { Design } from "./show.js";

const LANES = 3;

function releaseContext(canvas: HTMLCanvasElement) {
  // Asking for a context returns the existing one; only WebGL canvases have one to lose.
  for (const kind of ["webgl2", "webgl"] as const) {
    try {
      const context = canvas.getContext(kind) as WebGLRenderingContext | null;
      if (context) return context.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      // A 2D or WebGPU canvas refuses a WebGL context; nothing to release.
    }
  }
}

/**
 * Renders one design at a time into `container`, driving the booth scene with the same
 * per-lane inputs the live booth derives from CDJs: waveform colour history, energy, beat.
 */
export function createStage(container: HTMLElement, decks: PreviewDeck[]) {
  // Each stage owns one layer, so a stage being replaced can never clear its successor's scene.
  const layer = document.createElement("div");
  layer.className = "stage-layer";
  const host = document.createElement("canvas");
  host.className = "stage-host";
  const veil = document.createElement("div");
  veil.className = "stage-veil";
  layer.append(host, veil);
  container.append(layer);

  const rgba = new Uint8Array(256 * LANES * 4);
  const energy = new Float32Array(LANES * 4);
  const motion = new Float32Array(LANES * 4);
  const audible = new Float32Array(LANES);
  const origins = new Float32Array([-0.55, 0, 0, 0, 0.55, 0]);
  const bins = new Uint8Array(512);
  const lanes: MusicLane[] = decks.map(() => ({
    trackId: null,
    waveform: null,
    time: 0,
    playing: false,
    level: 0,
    bpm: 120,
    spectrum: new Uint8Array(bins.length),
    sampleRate: 44_100,
  }));

  let engine: SceneEngine | undefined;
  let shown: Design | undefined;
  let token = 0;
  let blackout = false;
  let disposed = false;
  let clock = 0;
  let last = performance.now();
  let frame = 0;
  let capture: ((image: Blob | null) => void) | undefined;
  let onError: (message: string) => void = () => {};

  const smooth = (array: Float32Array, i: number, value: number, dt: number) => {
    array[i] = array[i]! + (value - array[i]!) * (1 - Math.exp(-dt * 7));
  };
  const average = (from: number, to: number) => {
    let sum = 0;
    for (let k = from; k < to; k++) sum += bins[k]!;
    return sum / (to - from) / 255;
  };

  const sample = (dt: number) => {
    for (let lane = 0; lane < LANES; lane++) {
      const deck = decks[lane];
      const playing = !!deck?.playing;
      let low = 0,
        mid = 0,
        high = 0;
      if (deck?.analyser && playing) {
        deck.analyser.getByteFrequencyData(bins);
        low = average(1, 7);
        mid = average(7, 80);
        high = average(80, 220);
      }
      const level = playing ? ((low + mid + high) / 3) * (deck?.fader ?? 0) : 0;
      [level, low, mid, high].forEach((v, k) => smooth(energy, lane * 4 + k, v, dt));
      smooth(audible, lane, level, dt);
      const music = lanes[lane];
      if (music && deck) {
        music.trackId = deck.track?.id ?? null;
        music.waveform = deck.waveform;
        music.rhythm = deck.rhythm;
        music.time = deck.audio.currentTime;
        music.playing = playing;
        music.level = audible[lane]!;
        music.bpm = deck.bpm;
        if (deck.analyser && playing) {
          music.spectrum?.set(bins);
          music.sampleRate = deck.analyser.context.sampleRate;
        } else music.spectrum?.fill(0);
      }
      const position = deck?.audio.currentTime ?? 0;
      const bpm = deck?.bpm ?? 120;
      motion[lane * 4 + 3] = waveformBeat(deck?.waveform, position, bpm);
      const history = (8 * 60) / (bpm || 120);
      for (let x = 0; x < 256; x++) {
        const signal = shapeWaveformSignal(
          waveformSignal(deck?.waveform, position - (x / 255) * history),
          FLAT_WAVEFORM_BANDS,
        );
        const offset = (lane * 256 + x) * 4;
        const color = signal.color ?? [192, 192, 192];
        for (let c = 0; c < 3; c++) rgba[offset + c] = Math.max(0, Math.min(255, color[c]!));
        rgba[offset + 3] = Math.round(signal.amplitude * 255);
      }
    }
  };

  /** Composite every scene layer into a small JPEG, in the frame it was drawn. */
  const grab = () => {
    const done = capture;
    capture = undefined;
    const thumb = document.createElement("canvas");
    thumb.width = 480;
    thumb.height = 270;
    const context = thumb.getContext("2d")!;
    context.fillStyle = "#000";
    context.fillRect(0, 0, thumb.width, thumb.height);
    for (const canvas of layer.querySelectorAll("canvas")) {
      if (canvas === host || !canvas.width || !canvas.height) continue;
      const scale = Math.max(thumb.width / canvas.width, thumb.height / canvas.height);
      const w = canvas.width * scale,
        h = canvas.height * scale;
      context.drawImage(canvas, (thumb.width - w) / 2, (thumb.height - h) / 2, w, h);
    }
    thumb.toBlob((blob) => done?.(blob), "image/jpeg", 0.82);
  };

  const loop = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    sample(dt);
    if (engine && shown) {
      try {
        engine.setLook?.(shown.look);
        engine.setMusic?.(lanes);
        engine.draw(clock, rgba, energy, motion, origins, audible);
        if (capture) grab();
      } catch (error) {
        onError(`Scene stopped: ${String(error)}`);
        teardown();
      }
    }
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);

  const teardown = () => {
    engine?.dispose();
    engine = undefined;
    // Scenes insert their canvases and overlays beside the host; clear any leftovers.
    for (const child of [...layer.children])
      if (child !== host && child !== veil) {
        // Hand the GPU context back now; browsers allow only a few at once and kill the oldest.
        if (child instanceof HTMLCanvasElement) releaseContext(child);
        child.remove();
      }
  };

  const setVeil = (opacity: number, ms: number, animation = "") => {
    veil.style.transition = `opacity ${ms}ms ease`;
    // Restart the intro animation even when the same one runs twice in a row.
    veil.style.animation = "none";
    void veil.offsetWidth;
    veil.style.animation = animation;
    veil.style.opacity = String(blackout ? 1 : opacity);
  };

  return {
    /** Show a design; a different scene enters through the design's intro. */
    async show(design: Design) {
      if (disposed) return;
      const previous = shown;
      shown = design;
      if (previous?.scene === design.scene && engine) return;
      const current = ++token;
      setVeil(1, previous ? 160 : 0);
      if (previous) await new Promise((resolve) => setTimeout(resolve, 170));
      if (current !== token) return;
      teardown();
      try {
        const created = await sceneInfo(design.scene).create(host);
        if (current !== token) return created.dispose();
        engine = created;
      } catch (error) {
        capture?.(null);
        capture = undefined;
        onError(`${sceneInfo(design.scene).label} is unavailable here: ${String(error)}`);
        return;
      }
      // Let the scene render a frame before revealing it.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (current !== token) return;
      if (design.intro === "cut") setVeil(0, 0);
      else if (design.intro === "flicker") setVeil(0, 0, "stage-flicker 1.4s linear");
      else setVeil(0, 900);
    },
    setBlackout(on: boolean) {
      blackout = on;
      setVeil(on ? 1 : 0, 250);
    },
    status() {
      return engine?.status?.() ?? "";
    },
    capture() {
      if (!engine) return Promise.resolve(null);
      return new Promise<Blob | null>((resolve) => {
        capture = resolve;
      });
    },
    onError(handler: (message: string) => void) {
      onError = handler;
    },
    dispose() {
      // Abandon any scene still loading, so it cannot appear after the stage is gone.
      disposed = true;
      token++;
      cancelAnimationFrame(frame);
      teardown();
      layer.remove();
    },
  };
}

export type Stage = ReturnType<typeof createStage>;
