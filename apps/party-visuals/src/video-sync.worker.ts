import { alignVideo, fingerprintAudio, type AudioFingerprint } from "./video-sync.js";

self.onmessage = (
  event: MessageEvent<{ samples: Float32Array; sampleRate: number; reference: AudioFingerprint }>,
) => {
  const { samples, sampleRate, reference } = event.data;
  try {
    const result = alignVideo(fingerprintAudio(samples, sampleRate), reference);
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};
