import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { TrackCue, TrackWaveform } from "../../shared/types.js";
import { rekordboxHotCueColor } from "../cue-palette.js";

type PlayerWaveformCanvasProps = {
  currentTime: number;
  cues: ReadonlyArray<TrackCue>;
  disabled: boolean;
  duration: number;
  onSeek(seconds: number): void;
  waveform: TrackWaveform | null;
};

const pixelsPerSecond = 64;

/** High-DPI, fixed-playhead detail waveform inspired by 0xCONTROL's detail canvas. */
export function PlayerWaveformCanvas({
  currentTime,
  cues,
  disabled,
  duration,
  onSeek,
  waveform,
}: PlayerWaveformCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const timeRef = useRef(currentTime);
  const dragRef = useRef<
    | {
        moved: boolean;
        pointerId: number;
        startX: number;
        startTime: number;
      }
    | undefined
  >(undefined);
  const suppressClickRef = useRef(false);
  const [size, setSize] = useState({ width: 960, height: 96 });

  timeRef.current = currentTime;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.max(1, Math.floor(entry.contentRect.width));
      const height = Math.max(1, Math.floor(entry.contentRect.height));
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    canvas.style.width = `${String(size.width)}px`;
    canvas.style.height = `${String(size.height)}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    let animationFrame = 0;
    const draw = () => {
      drawWaveform(context, size, waveform, duration, timeRef.current, cues);
      animationFrame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(animationFrame);
  }, [cues, duration, size, waveform]);

  const seekFromPointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - drag.startX) > 2) drag.moved = true;
    const next = drag.startTime - (event.clientX - drag.startX) / pixelsPerSecond;
    onSeek(clamp(next, 0, duration));
  };

  return (
    <div ref={containerRef} className="player-waveform-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="player-waveform-canvas"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label="Interactive scrolling track waveform"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        aria-disabled={disabled}
        onPointerDown={(event) => {
          if (disabled) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            moved: false,
            pointerId: event.pointerId,
            startX: event.clientX,
            startTime: timeRef.current,
          };
          event.currentTarget.classList.add("is-dragging");
        }}
        onPointerMove={seekFromPointer}
        onPointerUp={(event) => {
          seekFromPointer(event);
          suppressClickRef.current = dragRef.current?.moved ?? false;
          dragRef.current = undefined;
          event.currentTarget.classList.remove("is-dragging");
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          dragRef.current = undefined;
          event.currentTarget.classList.remove("is-dragging");
        }}
        onClick={(event) => {
          if (disabled) return;
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          const offset = event.clientX - bounds.left - bounds.width / 2;
          onSeek(clamp(timeRef.current + offset / pixelsPerSecond, 0, duration));
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          const step = event.shiftKey ? 1 : 5;
          if (event.key === "ArrowLeft") onSeek(clamp(timeRef.current - step, 0, duration));
          else if (event.key === "ArrowRight") onSeek(clamp(timeRef.current + step, 0, duration));
          else if (event.key === "Home") onSeek(0);
          else if (event.key === "End") onSeek(duration);
          else return;
          event.preventDefault();
        }}
      />
    </div>
  );
}

function drawWaveform(
  context: CanvasRenderingContext2D,
  size: { width: number; height: number },
  waveform: TrackWaveform | null,
  duration: number,
  currentTime: number,
  cues: ReadonlyArray<TrackCue>,
): void {
  const { width, height } = size;
  const centerX = width / 2;
  const startTime = currentTime - centerX / pixelsPerSecond;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#06070a";
  context.fillRect(0, 0, width, height);

  const labelHeight = 15;
  const midline = labelHeight + (height - labelHeight) / 2;
  const peaks = waveform?.peaks;
  const colors = waveform?.colors;
  if (peaks?.length && duration > 0) {
    for (let x = 0; x < width; x++) {
      const time = startTime + x / pixelsPerSecond;
      if (time < 0 || time > duration) continue;
      const exactIndex = (time / duration) * (peaks.length - 1);
      const firstIndex = Math.floor(exactIndex);
      const secondIndex = Math.min(peaks.length - 1, firstIndex + 1);
      const mix = exactIndex - firstIndex;
      const amplitude = lerp(peaks[firstIndex] ?? 0, peaks[secondIndex] ?? 0, mix);
      const firstColor = colors?.[firstIndex] ?? [68, 104, 255];
      const secondColor = colors?.[secondIndex] ?? firstColor;
      const red = Math.round(lerp(firstColor[0], secondColor[0], mix));
      const green = Math.round(lerp(firstColor[1], secondColor[1], mix));
      const blue = Math.round(lerp(firstColor[2], secondColor[2], mix));
      const waveformHeight = Math.max(1, amplitude * (height - labelHeight - 3) * 0.48);
      context.fillStyle = `rgb(${String(red)} ${String(green)} ${String(blue)})`;
      context.fillRect(x, Math.round(midline - waveformHeight), 1, Math.ceil(waveformHeight * 2));
    }
  }

  context.fillStyle = "rgb(255 255 255 / 10%)";
  context.fillRect(0, Math.round(midline), width, 1);
  drawBeatGrid(context, waveform, startTime, width, height);
  drawCues(context, cues, startTime, width, height);

  const playheadX = Math.round(centerX) + 0.5;
  context.strokeStyle = "rgb(255 255 255 / 96%)";
  context.lineWidth = 1;
  context.shadowColor = "rgb(255 255 255 / 45%)";
  context.shadowBlur = 5;
  context.beginPath();
  context.moveTo(playheadX, 0);
  context.lineTo(playheadX, height);
  context.stroke();
  context.shadowBlur = 0;
  context.fillStyle = "#f8fafc";
  context.beginPath();
  context.moveTo(playheadX - 4, 0);
  context.lineTo(playheadX + 4, 0);
  context.lineTo(playheadX, 6);
  context.closePath();
  context.fill();
}

function drawBeatGrid(
  context: CanvasRenderingContext2D,
  waveform: TrackWaveform | null,
  startTime: number,
  width: number,
  height: number,
): void {
  for (const entry of waveform?.beatGrid ?? []) {
    const x = Math.round((entry.timeSeconds - startTime) * pixelsPerSecond) + 0.5;
    if (x < -1 || x > width + 1) continue;
    const downbeat = entry.beat === 1;
    context.strokeStyle = downbeat ? "rgb(239 68 68 / 72%)" : "rgb(248 250 252 / 20%)";
    context.lineWidth = downbeat ? 1.25 : 1;
    context.beginPath();
    context.moveTo(x, 14);
    context.lineTo(x, height);
    context.stroke();
    context.fillStyle = downbeat ? "#ff5b5b" : "rgb(226 232 240 / 70%)";
    context.font = `700 8px "DM Mono", ui-monospace, monospace`;
    context.textAlign = "center";
    context.fillText(String(entry.beat), x, 10);
  }
}

function drawCues(
  context: CanvasRenderingContext2D,
  cues: ReadonlyArray<TrackCue>,
  startTime: number,
  width: number,
  height: number,
): void {
  for (const cue of cues) {
    const x = Math.round((cue.startSeconds - startTime) * pixelsPerSecond) + 0.5;
    if (x < -1 || x > width + 1) continue;
    const color = cue.kind === "hot" ? rekordboxHotCueColor(cue.colorTableIndex) : null;
    context.fillStyle = color ?? "#f59e0b";
    context.fillRect(x, 14, 2, height - 14);
  }
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
