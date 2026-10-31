import type { VisualLook } from "../../dj-monitor/src/visual-presets.js";
import type { ShowCue } from "./music/show-director.js";

const TAU = Math.PI * 2;
const fraction = (n: number) => n - Math.floor(n);
const random = (n: number) => fraction(Math.sin(n * 127.1 + 311.7) * 43758.5453);

/** A small, transparent lighting layer shared by GPU and canvas scenes. */
export function createAtmosphere(layer: HTMLElement) {
  const canvas = document.createElement("canvas");
  canvas.className = "stage-atmosphere";
  canvas.setAttribute("aria-hidden", "true");
  layer.append(canvas);
  const g = canvas.getContext("2d")!;
  let width = 0,
    height = 0,
    drift = 0;
  const haze = document.createElement("canvas");
  haze.width = 192;
  haze.height = 96;
  const h = haze.getContext("2d")!;
  const gradient = h.createRadialGradient(96, 48, 0, 96, 48, 96);
  gradient.addColorStop(0, "rgba(118, 136, 174, 0.16)");
  gradient.addColorStop(0.45, "rgba(83, 93, 134, 0.08)");
  gradient.addColorStop(1, "rgba(30, 20, 48, 0)");
  h.fillStyle = gradient;
  h.fillRect(0, 0, 192, 96);
  const motes = Array.from({ length: 112 }, (_, i) => ({
    x: random(i + 1),
    y: random(i + 200),
    z: 0.2 + random(i + 400) * 0.8,
    angle: random(i + 600) * TAU,
  }));
  return {
    canvas,
    draw(cue: ShowCue, look: VisualLook, dt: number, reduced: boolean, beatPulse = 0) {
      const w = Math.max(1, layer.clientWidth),
        ht = Math.max(1, layer.clientHeight);
      const ratio = Math.min(devicePixelRatio || 1, 1, 1280 / w, 1280 / ht);
      if (width !== w || height !== ht || canvas.width !== Math.round(w * ratio)) {
        width = w;
        height = ht;
        canvas.width = Math.round(w * ratio);
        canvas.height = Math.round(ht * ratio);
      }
      g.setTransform(ratio, 0, 0, ratio, 0, 0);
      g.clearRect(0, 0, width, height);
      const amount = Math.max(0, Math.min(1, look.halloween));
      if (!amount) return;
      // Quiet air movement continues at rest; only audible music drives the lighting.
      drift += reduced ? 0 : dt * Math.max(0, look.motion) * (0.12 + cue.energy * 0.25);
      const warm = cue.phase === "drop" || cue.phase === "build";
      const accent = warm ? "255, 133, 48" : "111, 210, 202";
      const strength = Math.min(1.5, look.intensity) * amount;
      g.globalCompositeOperation = "screen";
      // Peripheral light spills leave the centre of the game legible.
      for (const side of [0, 1]) {
        const x = width * side,
          y = height * 0.7;
        const glow = g.createRadialGradient(x, y, 0, x, y, width * 0.48);
        const pulse = reduced ? cue.energy * 0.025 : beatPulse * 0.13 + cue.bloom * 0.04;
        glow.addColorStop(
          0,
          `rgba(${side ? "153, 105, 227" : accent}, ${(0.025 + pulse) * strength})`,
        );
        glow.addColorStop(1, `rgba(${accent}, 0)`);
        g.fillStyle = glow;
        g.fillRect(0, 0, width, height);
      }
      g.globalAlpha = amount * (cue.phase === "break" ? 0.85 : 0.32 + cue.body * 0.22);
      for (let i = 0; i < 7; i++) {
        const x = fraction(i * 0.19 + drift * 0.012) * (width * 1.6) - width * 0.3;
        const y = height * (0.83 + Math.sin(i * 7 + drift * 0.3) * 0.06);
        g.drawImage(haze, x - width * 0.25, y, width * 0.65, height * 0.25);
      }
      const count = Math.round(motes.length * Math.max(0, Math.min(1, look.density)));
      for (let i = 0; i < count; i++) {
        const p = motes[i]!;
        const x = fraction(p.x + Math.sin(drift * 0.2 + p.angle) * 0.025) * width;
        const y = fraction(p.y - drift * 0.014 * p.z) * height;
        const size = (0.35 + p.z * 1.2) * Math.min(1.5, width / 1000);
        g.globalAlpha = amount * (0.05 + p.z * 0.16 + cue.air * 0.18);
        g.fillStyle = i % 4 === 0 ? "#ffd7a3" : "#a5e3db";
        g.beginPath();
        g.ellipse(x, y, size, size * (1 + cue.air), p.angle, 0, TAU);
        g.fill();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = "source-over";
      const vignette = g.createRadialGradient(
        width / 2,
        height * 0.45,
        width * 0.27,
        width / 2,
        height / 2,
        Math.max(width, height) * 0.7,
      );
      vignette.addColorStop(0, "transparent");
      vignette.addColorStop(1, `rgba(4, 3, 12, ${0.34 * amount})`);
      g.fillStyle = vignette;
      g.fillRect(0, 0, width, height);
    },
    dispose() {
      canvas.remove();
      haze.width = 0;
      haze.height = 0;
    },
  };
}
