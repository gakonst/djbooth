import { waveformBeat, waveformSignal } from "../../../dj-monitor/src/waveform-signal.js";
import type { MusicLane } from "../scenes.js";

const details = new WeakMap<object, Uint8Array>();
const clamp = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

/** Read the actual playhead, preferring the 150 Hz detail over the overview waveform. */
export function waveformAmplitude(lane: MusicLane): number {
  if (!lane.playing || lane.level <= 0 || !Number.isFinite(lane.time) || lane.time < 0) return 0;
  const bands = lane.rhythm?.bands;
  if (bands && bands.rate > 0) {
    let bytes = details.get(bands);
    if (!bytes) {
      try {
        bytes = Uint8Array.from(atob(bands.data), (value) => value.charCodeAt(0));
        details.set(bands, bytes);
      } catch {
        /* Fall back to the overview when detail data is unavailable. */
      }
    }
    if (bytes && bytes.length >= 3) {
      const position = lane.time * bands.rate;
      const index = Math.floor(position);
      const count = Math.floor(bytes.length / 3);
      if (index >= count) return 0;
      const sample = (at: number) =>
        Math.max(...[0, 1, 2].map((band) => bytes![Math.min(count - 1, at) * 3 + band]! / 127));
      return clamp(sample(index) * (1 - (position % 1)) + sample(index + 1) * (position % 1));
    }
  }
  return clamp(waveformSignal(lane.waveform, lane.time).amplitude);
}

/** Mix by audible level so crossfades blend both waveforms rather than jumping between decks. */
export function createWaveformPulse() {
  let envelope = 0;
  let baseline = 0;
  let hit = 0;
  let hue = 0;
  return {
    update(lanes: MusicLane[], elapsed: number) {
      const dt = Math.max(0, Math.min(0.1, elapsed));
      let weighted = 0,
        beats = 0,
        colorX = 0,
        colorY = 0,
        colorWeight = 0,
        weight = 0;
      for (const lane of lanes) {
        const gain = lane.playing ? clamp(lane.level) : 0;
        const sample = waveformAmplitude(lane);
        weighted += sample * gain;
        const position = waveformBeat(lane.waveform, lane.time, lane.sourceBpm ?? lane.bpm);
        const phase = ((position % 1) + 1) % 1;
        // Advance a palette step after each kick, using track time so seeks and
        // crossfades follow the music rather than a free-running rainbow.
        const progress = Math.min(1, phase / 0.4);
        const angle =
          ((Math.floor(position) + progress * progress * (3 - 2 * progress)) * 47 * Math.PI) / 180;
        const colorGain = sample * gain;
        colorX += Math.cos(angle) * colorGain;
        colorY += Math.sin(angle) * colorGain;
        colorWeight += colorGain;
        // The beat grid adds a clear kick even in heavily compressed tracks.
        // Waveform amplitude gates it, so pauses and silent passages stay still.
        beats += Math.exp(-phase * 10) * Math.min(1, sample * 2) * gain;
        weight += gain;
      }
      const amplitude = weight > 0 ? clamp((weighted / weight) * Math.min(1, weight * 4)) : 0;
      const beat = weight > 0 ? clamp((beats / weight) * Math.min(1, weight * 4)) : 0;
      const onset = Math.max(0, amplitude - baseline) * 3;
      baseline += (amplitude - baseline) * (1 - Math.exp(-dt * 3));
      envelope += (amplitude - envelope) * (1 - Math.exp(-dt * (amplitude > envelope ? 35 : 12)));
      hit = Math.max(hit * Math.exp(-dt * 10), clamp(onset));
      const targetHue = colorWeight > 0.001 ? (Math.atan2(colorY, colorX) * 180) / Math.PI : 0;
      const turn = ((targetHue - hue + 540) % 360) - 180;
      hue = (((hue + turn * (1 - Math.exp(-dt * 14))) % 360) + 360) % 360;
      return {
        amplitude: envelope,
        hit,
        beat,
        hue,
        pulse: clamp(envelope * 0.15 + hit * 0.55 + beat * 0.85),
      };
    },
  };
}
