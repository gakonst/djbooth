import { useEffect, useRef } from "react";

import type { TrackWaveform } from "./types.js";

type CdjWaveformProps = {
  playheadMs: number | null;
  bpm: number | null;
  waveform: TrackWaveform | null;
};

/** Scroll stable waveform tiles instead of resampling the peaks on every frame. */
export function CdjWaveform({ playheadMs, bpm, waveform }: CdjWaveformProps) {
  const visibleBeats = 16;
  const windowSeconds = (visibleBeats * 60) / (bpm && bpm > 0 ? bpm : 120);
  const drawRef = useRef<() => void>(() => {});
  const viewRef = useRef({ waveform, playheadMs, windowSeconds });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const tiles = new Map<number, HTMLCanvasElement>();
    let cachedWaveform: TrackWaveform | null = null;
    let cachedGeometry = "";
    const tileWidth = 512;
    const draw = () => {
      const bounds = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
      if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const view = viewRef.current;
      const pixelsPerSecond = width / view.windowSeconds;
      const geometry = `${width}:${height}:${ratio}:${view.windowSeconds}`;
      if (cachedWaveform !== view.waveform || cachedGeometry !== geometry) {
        tiles.clear();
        cachedWaveform = view.waveform;
        cachedGeometry = geometry;
      }
      const left = ((view.playheadMs ?? 0) / 1_000) * pixelsPerSecond - width / 2;
      const firstTile = Math.floor(left / tileWidth);
      const lastTile = Math.floor((left + width) / tileWidth);
      context.fillStyle = "#030405";
      context.fillRect(0, 0, width, height);
      for (let index = firstTile; index <= lastTile; index++) {
        let tile = tiles.get(index);
        if (!tile) {
          tile = document.createElement("canvas");
          tile.width = Math.ceil(tileWidth * ratio);
          tile.height = Math.ceil(height * ratio);
          const tileContext = tile.getContext("2d");
          if (!tileContext) continue;
          tileContext.setTransform(ratio, 0, 0, ratio, 0, 0);
          drawWaveform(
            tileContext,
            tileWidth,
            height,
            view.waveform,
            ((index + 0.5) * tileWidth) / pixelsPerSecond,
            tileWidth / pixelsPerSecond,
          );
          tiles.set(index, tile);
        }
        context.drawImage(tile, index * tileWidth - left, 0, tileWidth, height);
      }
      // Keep only nearby tiles; long tracks do not allocate track-sized canvases.
      for (const index of tiles.keys()) {
        if (index < firstTile - 1 || index > lastTile + 1) tiles.delete(index);
      }
    };
    drawRef.current = draw;
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    viewRef.current = { waveform, playheadMs, windowSeconds };
    drawRef.current();
  }, [waveform, playheadMs, windowSeconds]);

  return (
    <div className={`live-waveform ${waveform?.peaks.length ? "has-analysis" : "is-empty"}`}>
      <canvas ref={canvasRef} aria-hidden="true" />
      <b style={{ left: "50%" }} />
      {!waveform?.peaks.length ? <em>WAVEFORM UNAVAILABLE</em> : null}
    </div>
  );
}

function drawWaveform(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  waveform: TrackWaveform | null,
  positionSeconds: number,
  windowSeconds: number,
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
  const duration = waveform.durationSeconds;
  if (!(duration > 0)) return;
  const startSeconds = positionSeconds - windowSeconds / 2;
  for (const beat of waveform.beatGrid ?? []) {
    if (beat.timeSeconds < startSeconds) continue;
    if (beat.timeSeconds > startSeconds + windowSeconds) break;
    const x = ((beat.timeSeconds - startSeconds) / windowSeconds) * width;
    context.fillStyle = beat.beat === 1 ? "rgb(255 255 255 / 24%)" : "rgb(255 255 255 / 9%)";
    context.fillRect(Math.round(x), 0, 1, height);
  }

  for (let x = 0; x < width; x++) {
    const timeSeconds = startSeconds + (x / width) * windowSeconds;
    if (timeSeconds < 0 || timeSeconds > duration) continue;
    const exactIndex = (timeSeconds / duration) * (peaks.length - 1);
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
