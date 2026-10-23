/** A transparent, noninteractive view of the same analyzed rows used by the game. */
export function drawBoothWaveformOverlay(
  canvas: HTMLCanvasElement,
  rgba: Uint8Array,
  active: boolean[],
  beatPulses: Float32Array,
) {
  const lanes = active.flatMap((playing, lane) => (playing ? [lane] : []));
  const width = Math.min(720, Math.max(240, innerWidth * 0.62));
  const height = Math.max(1, lanes.length * 58);
  const ratio = Math.min(devicePixelRatio, 2);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  canvas.dataset.activeDecks = lanes.map((lane) => lane + 1).join(",");
  canvas.hidden = lanes.length === 0;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const tints = ["#71e4ff", "#ff86bb", "#ffd885"];
  lanes.forEach((lane, row) => {
    const y = row * 58 + 29;
    const left = 61,
      plotWidth = width - left - 12;
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillStyle = tints[lane]!;
    ctx.fillText(`CDJ ${lane + 1}`, 3, y + 3);
    ctx.strokeStyle = "rgba(230,239,255,0.22)";
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - 12, y);
    ctx.stroke();
    for (let i = 0; i < 256; i++) {
      const offset = (lane * 256 + 255 - i) * 4;
      const amplitude = (rgba[offset + 3] ?? 0) / 255;
      const fade = Math.min(1, i / 24, (255 - i) / 12);
      const halfHeight = Math.max(0.5, Math.sqrt(amplitude) * 19);
      ctx.fillStyle = `rgba(${Math.max(100, rgba[offset] ?? 0)},${Math.max(100, rgba[offset + 1] ?? 0)},${Math.max(100, rgba[offset + 2] ?? 0)},${fade})`;
      ctx.fillRect(
        left + (i / 256) * plotWidth,
        y - halfHeight,
        Math.max(1, plotWidth / 256 - 0.6),
        halfHeight * 2,
      );
    }
    // A small beat lamp keeps the playhead readable without covering the game.
    ctx.fillStyle = tints[lane]!;
    ctx.globalAlpha = 0.35 + (beatPulses[lane] ?? 0) * 0.65;
    ctx.fillRect(width - 10, y - 19, 1, 38);
    ctx.globalAlpha = 1;
  });
}
