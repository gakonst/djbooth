import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

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
    const firstColor = colors?.[firstIndex] ?? [68, 104, 255];
    const secondColor = colors?.[secondIndex] ?? firstColor;
    const red = Math.round(lerp(firstColor[0], secondColor[0], mix));
    const green = Math.round(lerp(firstColor[1], secondColor[1], mix));
    const blue = Math.round(lerp(firstColor[2], secondColor[2], mix));
    const waveformHeight = Math.max(1, amplitude * (height / 2 - 1));
    context.fillStyle = `rgb(${String(red)} ${String(green)} ${String(blue)})`;
    context.fillRect(x, Math.round(midline - waveformHeight), 1, Math.ceil(waveformHeight * 2));
  }

  context.fillStyle = "rgb(255 255 255 / 14%)";
  context.fillRect(0, Math.floor(midline), width, 1);
}

export const RgbWaveform = forwardRef<
  HTMLCanvasElement,
  { waveform?: TrackWaveform | null; className?: string }
>(function RgbWaveform({ waveform, className }, forwardedRef) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useImperativeHandle(forwardedRef, () => canvasRef.current!, []);

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
});

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}
