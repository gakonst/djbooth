import { useEffect, useRef } from "react";

import type { TrackWaveform } from "./types";

type CdjWaveformProps = {
  progress: number;
  waveform: TrackWaveform | null;
};

/** The same high-DPI RGB interpolation used by the djbooth/Tauri player surface. */
export function CdjWaveform({ progress, waveform }: CdjWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawWaveform(context, width, height, waveform);
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [waveform]);

  return (
    <div className={`live-waveform ${waveform?.peaks.length ? "has-analysis" : "is-empty"}`}>
      <canvas ref={canvasRef} aria-hidden="true" />
      <b style={{ left: `${progress}%` }} />
      {!waveform?.peaks.length ? <em>WAVEFORM UNAVAILABLE</em> : null}
    </div>
  );
}

function drawWaveform(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  waveform: TrackWaveform | null,
): void {
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#030405";
  context.fillRect(0, 0, width, height);
  if (!waveform?.peaks.length) {
    context.fillStyle = "rgb(74 91 101 / 35%)";
    context.fillRect(0, Math.floor(height / 2), width, 1);
    return;
  }

  const peaks = waveform.peaks;
  const colors = waveform.colors;
  const midline = height / 2;

  for (let x = 0; x < width; x++) {
    const exactIndex = (x / Math.max(1, width - 1)) * (peaks.length - 1);
    const firstIndex = Math.floor(exactIndex);
    const secondIndex = Math.min(peaks.length - 1, firstIndex + 1);
    const mix = exactIndex - firstIndex;
    const amplitude = clamp(
      lerp(Number(peaks[firstIndex] ?? 0), Number(peaks[secondIndex] ?? 0), mix),
      0,
      1,
    );
    if (!amplitude) continue;
    const firstColor = colors?.[firstIndex] ?? [28, 117, 255];
    const secondColor = colors?.[secondIndex] ?? firstColor;
    const [red, green, blue] = brightenWaveformColor([
      lerp(firstColor[0], secondColor[0], mix),
      lerp(firstColor[1], secondColor[1], mix),
      lerp(firstColor[2], secondColor[2], mix),
    ]);
    const waveformHeight = Math.max(1, amplitude * (height / 2 - 2));
    context.fillStyle = `rgb(${String(red)} ${String(green)} ${String(blue)})`;
    context.fillRect(x, Math.round(midline - waveformHeight), 1, Math.ceil(waveformHeight * 2));
  }

  context.fillStyle = "rgb(255 255 255 / 16%)";
  context.fillRect(0, Math.floor(midline), width, 1);
}

function brightenWaveformColor(color: [number, number, number]): [number, number, number] {
  const brightest = Math.max(...color);
  if (brightest <= 0) return [28, 117, 255];
  // PWV4 is authored for the CDJ's very bright LCD and looks artificially dim
  // when copied numerically to a browser canvas. Preserve its hue while lifting
  // every peak to the same luminous range as the physical display.
  const gain = Math.max(1.35, 210 / brightest);
  return color.map((channel) => Math.round(clamp(channel * gain, 0, 255))) as [
    number,
    number,
    number,
  ];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}
