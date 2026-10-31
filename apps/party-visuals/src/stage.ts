import {
  FLAT_WAVEFORM_BANDS,
  shapeWaveformSignal,
  waveformBeat,
  waveformSignal,
} from "../../dj-monitor/src/waveform-signal.js";
import { createLiveMusic } from "./live-music.js";
import type { PreviewDeck } from "./decks.js";
import { sceneInfo, type MusicLane, type SceneEngine } from "./scenes.js";
import type { Design } from "./show.js";
import { createShowDirector, type ShowCue } from "./music/show-director.js";
import { createAtmosphere } from "./atmosphere.js";
import { createDanceMotion } from "../../dj-monitor/src/music-dance.js";
import { createBeatPulse } from "./music/beat-pulse.js";
import type { VideoDeck } from "./track-video.js";

const LANES = 3;
export type MusicInput = "demo" | "live";

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
  const atmosphere = createAtmosphere(layer);

  const rgba = new Uint8Array(256 * LANES * 4);
  const energy = new Float32Array(LANES * 4);
  const motion = new Float32Array(LANES * 4);
  const audible = new Float32Array(LANES);
  const origins = new Float32Array([-0.55, 0, 0, 0, 0.55, 0]);
  const bins = new Uint8Array(512);
  const liveMusic = createLiveMusic();
  const director = createShowDirector();
  const choreography = createDanceMotion();
  const beatPulse = createBeatPulse();
  let cue: ShowCue | undefined;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const lanes: MusicLane[] = Array.from({ length: LANES }, () => ({
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
  let inputStatus = "Waiting for music";
  let inputSource: MusicInput = "demo";
  let liveLanes: ReturnType<typeof liveMusic.sample> = [];
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

  let historyElapsed = 1;
  const sample = (dt: number) => {
    historyElapsed += dt;
    const refreshHistory = historyElapsed >= 1 / 30;
    if (refreshHistory) historyElapsed %= 1 / 30;
    const live = (liveLanes = liveMusic.sample());
    const previewPlaying = decks.some((deck) => deck.playing && deck.fader > 0.008);
    const useLive = inputSource === "live";
    inputStatus = useLive
      ? live.length
        ? `${live.length} connected CDJ${live.length === 1 ? "" : "s"} · ${live.filter((lane) => lane.deck.playing).length} playing`
        : liveMusic.connected()
          ? "Waiting for connected CDJs"
          : "Connecting to DJBooth…"
      : previewPlaying
        ? "Demo audio"
        : "Demo · choose a song or play the Halloween set";
    for (let lane = 0; lane < LANES; lane++) {
      const deck = decks[lane];
      const hardware = useLive ? live[lane] : undefined;
      const playing = useLive ? !!hardware?.deck.playing : !!deck?.playing;
      const waveform = useLive ? hardware?.waveform : deck?.waveform;
      const position = useLive ? (hardware?.time ?? 0) : (deck?.audio.currentTime ?? 0);
      const bpm = useLive ? (hardware?.bpm ?? 120) : (deck?.bpm ?? 120);
      const sourceBpm = useLive
        ? (hardware?.deck.bpm ?? hardware?.bpm ?? 120)
        : (deck?.sourceBpm ?? 120);
      let low = 0,
        mid = 0,
        high = 0;
      if (!useLive && deck?.analyser && playing) {
        deck.analyser.getByteFrequencyData(bins);
        low = average(1, 7) * deck.fader;
        mid = average(7, 80) * deck.fader;
        high = average(80, 220) * deck.fader;
      }
      if (hardware && playing) {
        low = hardware.signal.low * hardware.signal.level;
        mid = hardware.signal.mid * hardware.signal.level;
        high = hardware.signal.high * hardware.signal.level;
      }
      const level = playing ? (hardware?.signal.level ?? (low + mid + high) / 3) : 0;
      [level, low, mid, high].forEach((v, k) => smooth(energy, lane * 4 + k, v, dt));
      smooth(audible, lane, level, dt);
      const music = lanes[lane];
      if (music) {
        music.trackId = useLive ? (hardware?.trackId ?? null) : (deck?.track?.id ?? null);
        music.waveform = waveform ?? null;
        music.rhythm = useLive ? null : deck?.rhythm;
        music.time = position;
        music.playing = playing;
        music.level = playing && (useLive || (deck?.fader ?? 0) > 0) ? audible[lane]! : 0;
        music.bpm = bpm;
        music.sourceBpm = sourceBpm;
        if (!useLive && deck?.analyser && playing) {
          music.spectrum?.set(bins);
          music.sampleRate = deck.analyser.context.sampleRate;
        } else music.spectrum?.fill(0);
      }
      motion[lane * 4 + 3] = waveformBeat(waveform, position, sourceBpm);
      [hardware?.signal.color ?? 0, hardware?.signal.fx ?? 0, hardware?.signal.effect ?? 0].forEach(
        (value, index) => smooth(motion, lane * 4 + index, value, dt),
      );
      const history = (8 * 60) / (sourceBpm || 120);
      for (let x = 0; x < 256; x++) {
        const signal = shapeWaveformSignal(
          waveformSignal(waveform, position - (x / 255) * history),
          hardware?.bands ?? FLAT_WAVEFORM_BANDS,
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
    cue = director.update(lanes, energy, dt);
    const pulse = beatPulse.update(
      cue.beat,
      cue.active ? cue.energy : 0,
      dt,
      reducedMotion.matches,
    );
    layer.style.setProperty(
      "--music-pulse",
      String(pulse * Math.min(1.5, Math.max(0, shown?.look.intensity ?? 1))),
    );
    const dance = choreography.update(
      cue.beat,
      cue.active ? cue.energy : 0,
      cue.bass,
      cue.body,
      cue.air,
      dt,
    );
    if (engine && shown) {
      try {
        engine.setLook?.(shown.look);
        engine.setMusic?.(lanes);
        engine.setDance?.(dance);
        engine.draw(clock, rgba, energy, motion, origins, audible);
        atmosphere.draw(cue, shown.look, dt, reducedMotion.matches, pulse);
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
      if (child !== host && child !== veil && child !== atmosphere.canvas) {
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
    setMidi: liveMusic.setMidi,
    hardwareSnapshot: liveMusic.snapshot,
    setInputSource(source: MusicInput) {
      inputSource = source;
    },
    videoDecks(): VideoDeck[] {
      if (inputSource === "demo") return decks;
      return liveLanes.map(({ deck, videoTrack, time, bpm, gain }) => ({
        playing: deck.playing,
        fader: gain,
        track: videoTrack,
        audio: { currentTime: time, playbackRate: deck.bpm ? bpm / deck.bpm : 1 },
      }));
    },
    input() {
      return {
        source: inputSource,
        status: inputStatus,
        connected: liveMusic.connected(),
        midi: liveMusic.midi(),
        decks: liveLanes.map(({ deck, bpm, time, waveform }) => ({
          player: deck.player,
          model: deck.model ?? "CDJ",
          title: deck.trackTitle,
          artist: deck.trackArtist,
          playing: deck.playing,
          bpm: deck.trackId == null ? null : bpm,
          time,
          analyzed: !!waveform?.beatGrid?.length,
        })),
      };
    },
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
      else if (design.intro === "flicker" && !reducedMotion.matches)
        setVeil(0, 0, "stage-flicker 1.4s linear");
      else setVeil(0, 900);
    },
    setBlackout(on: boolean) {
      blackout = on;
      setVeil(on ? 1 : 0, 250);
    },
    status() {
      const detail = engine?.status?.();
      return detail ? `${inputStatus} · ${detail}` : inputStatus;
    },
    cue() {
      return cue;
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
      liveMusic.dispose();
      teardown();
      atmosphere.dispose();
      capture?.(null);
      capture = undefined;
      layer.remove();
    },
  };
}

export type Stage = ReturnType<typeof createStage>;
