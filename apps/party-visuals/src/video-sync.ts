export type AudioFingerprint = { rate: number; duration: number; values: number[] };
export type VideoAnchor = { audio: number; video: number; confidence: number };
export type VideoAlignment = { anchors: VideoAnchor[]; confidence: number };

/** Compact, gain-independent low/mid/high envelopes; no audio is retained in the fingerprint. */
export function fingerprintAudio(samples: Float32Array, sampleRate: number): AudioFingerprint {
  const rate = 20;
  const hop = Math.max(1, Math.round(sampleRate / rate));
  const values: number[] = [];
  let low = 0,
    mid = 0;
  const lowAlpha = 1 - Math.exp((-2 * Math.PI * 140) / sampleRate);
  const midAlpha = 1 - Math.exp((-2 * Math.PI * 900) / sampleRate);
  for (let from = 0; from + hop <= samples.length; from += hop) {
    let l = 0,
      m = 0,
      h = 0;
    for (let i = from; i < from + hop; i++) {
      const sample = samples[i]!;
      low += (sample - low) * lowAlpha;
      mid += (sample - mid) * midAlpha;
      l += low * low;
      m += (mid - low) ** 2;
      h += (sample - mid) ** 2;
    }
    values.push(
      Math.log1p(Math.sqrt(l / hop) * 100),
      Math.log1p(Math.sqrt(m / hop) * 100),
      Math.log1p(Math.sqrt(h / hop) * 100),
    );
  }
  return { rate, duration: samples.length / sampleRate, values };
}

/** Compare actual sound at regular checkpoints, so film intros and edited sections are detected. */
export function alignVideo(audio: AudioFingerprint, video: AudioFingerprint): VideoAlignment {
  if (audio.rate !== video.rate) return { anchors: [], confidence: 0 };
  const rate = audio.rate,
    radius = Math.round(rate * 3),
    step = 2;
  const audioCount = Math.floor(audio.values.length / 3),
    videoCount = Math.floor(video.values.length / 3);
  const anchors: VideoAnchor[] = [];
  for (let center = radius; center < audioCount - radius; center += Math.round(rate * 8)) {
    const reference: number[] = [];
    let sum = 0,
      squared = 0;
    for (let j = -radius; j < radius; j += step)
      for (let b = 0; b < 3; b++) {
        const x = audio.values[(center + j) * 3 + b]!;
        reference.push(x);
        sum += x;
        squared += x * x;
      }
    const n = reference.length,
      mean = sum / n,
      variance = squared - sum * mean;
    if (variance < 0.01) continue;
    let best = -1,
      at = 0;
    for (let candidate = radius; candidate < videoCount - radius; candidate++) {
      let sumY = 0,
        squaredY = 0,
        product = 0,
        k = 0;
      for (let j = -radius; j < radius; j += step)
        for (let b = 0; b < 3; b++) {
          const y = video.values[(candidate + j) * 3 + b]!;
          sumY += y;
          squaredY += y * y;
          product += reference[k++]! * y;
        }
      const denominator = Math.sqrt(Math.max(0, variance * (squaredY - (sumY * sumY) / n)));
      const score = denominator > 0 ? (product - mean * sumY) / denominator : 0;
      if (score > best) {
        best = score;
        at = candidate;
      }
    }
    if (best >= 0.82) anchors.push({ audio: center / rate, video: at / rate, confidence: best });
  }
  // A lone rhythmic coincidence cannot establish an exact recording match.
  const supported = anchors.filter((anchor, i) =>
    anchors.some(
      (other, j) =>
        i !== j &&
        Math.abs(other.audio - anchor.audio) <= 25 &&
        Math.abs(other.video - anchor.video - (other.audio - anchor.audio)) < 0.25,
    ),
  );
  return {
    anchors: supported,
    confidence:
      supported.length >= 3
        ? supported.reduce((n, a) => n + a.confidence, 0) / supported.length
        : 0,
  };
}

/** Interpolate within matching edits; a cut switches segments instead of stretching the film. */
export function alignedVideoTime(alignment: VideoAlignment, audioTime: number): number | null {
  const anchors = alignment.anchors;
  if (alignment.confidence < 0.82 || anchors.length < 3) return null;
  if (audioTime < anchors[0]!.audio - 4 || audioTime > anchors.at(-1)!.audio + 4) return null;
  let index = 0;
  while (index < anchors.length - 1 && anchors[index + 1]!.audio <= audioTime) index++;
  const before = anchors[index]!,
    after = anchors[index + 1];
  const offset = before.video - before.audio;
  if (
    after &&
    after.audio - before.audio <= 25 &&
    Math.abs(after.video - after.audio - offset) < 0.25
  ) {
    const fraction = Math.max(
      0,
      Math.min(1, (audioTime - before.audio) / (after.audio - before.audio)),
    );
    return audioTime + offset + fraction * (after.video - after.audio - offset);
  }
  if (after && Math.abs(audioTime - after.audio) <= 4) return audioTime + after.video - after.audio;
  return Math.abs(audioTime - before.audio) <= 4 ? audioTime + offset : null;
}

export type VideoSyncAction = { time: number; rate: number; seek: boolean };

/** Audio is the master clock. Small decoder drift is corrected by rate; seeks are immediate. */
export function videoSyncAction(
  target: number,
  current: number,
  playbackRate: number,
  duration: number,
  force = false,
): VideoSyncAction {
  const time = Math.max(
    0,
    Math.min(Number.isFinite(duration) ? Math.max(0, duration - 0.025) : target, target),
  );
  const error = time - current;
  const base = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  return {
    time,
    rate: Math.max(0.25, Math.min(4, base + Math.max(-0.04, Math.min(0.04, error * 0.7)))),
    seek: force || Math.abs(error) > 0.12,
  };
}
