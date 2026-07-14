import { useEffect, useRef } from "react";

import type { TrackWaveform } from "../../shared/types.js";

type Peaks = Array<Float32Array | number[]>;

/** Draw Rekordbox frequency colours around a centred play axis. */
export function renderRgbWaveform(
  channels: Peaks,
  colors: ReadonlyArray<readonly [number, number, number]> | undefined,
  context: CanvasRenderingContext2D,
  size?: { width: number; height: number },
): void {
  const peaks = channels[0];
  if (!peaks?.length) return;
  const width = size?.width ?? context.canvas.width;
  const height = size?.height ?? context.canvas.height;
  if (!width || !height) return;

  context.clearRect(0, 0, width, height);
  const columnWidth = Math.max(1, Math.round(width / 260));
  const gap = Math.max(1, Math.floor(columnWidth / 2));
  const columns = Math.max(1, Math.floor(width / (columnWidth + gap)));
  const midline = height / 2;

  for (let column = 0; column < columns; column++) {
    const index = Math.min(peaks.length - 1, Math.floor((column * peaks.length) / columns));
    const amplitude = clamp(Number(peaks[index] ?? 0), 0, 1);
    if (!amplitude) continue;
    const [red, green, blue] = colors?.[index] ?? [68, 104, 255];
    const waveformHeight = Math.max(1, amplitude * (height / 2 - 1));
    const x = column * (columnWidth + gap);
    const gradient = context.createLinearGradient(0, midline - waveformHeight, 0, midline);
    gradient.addColorStop(0, `rgb(${String(red)} ${String(green)} ${String(blue)} / 0.55)`);
    gradient.addColorStop(0.55, `rgb(${String(red)} ${String(green)} ${String(blue)} / 1)`);
    gradient.addColorStop(1, `rgb(${String(red)} ${String(green)} ${String(blue)})`);
    context.fillStyle = gradient;
    context.fillRect(x, midline - waveformHeight, columnWidth, waveformHeight * 2);
  }

  context.fillStyle = "rgb(255 255 255 / 14%)";
  context.fillRect(0, Math.floor(midline), width, 1);
}

export function RgbWaveform({
  waveform,
  className,
}: {
  waveform?: TrackWaveform | null;
  className?: string;
}) {
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
      context.clearRect(0, 0, width, height);
      if (waveform?.peaks.length)
        renderRgbWaveform([waveform.peaks], waveform.colors, context, { width, height });
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [waveform]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
