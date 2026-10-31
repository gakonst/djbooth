import type { AudioFingerprint, VideoAlignment } from "./video-sync.js";

const cache = new Map<string, Promise<VideoAlignment | null>>();

/** Decode only the selected track, then match its sound to a compact video reference off-thread. */
export function alignmentForTrack(trackId: string, clipId: string): Promise<VideoAlignment | null> {
  const key = `${trackId}:${clipId}`;
  let result = cache.get(key);
  if (!result) {
    result = load(trackId, clipId).catch(() => null);
    cache.set(key, result);
    if (cache.size > 12) cache.delete(cache.keys().next().value!);
  }
  return result;
}

async function load(trackId: string, clipId: string): Promise<VideoAlignment | null> {
  const referenceResponse = await fetch(`/clip-sync/${encodeURIComponent(clipId)}.json`);
  if (!referenceResponse.ok) return null;
  const reference = (await referenceResponse.json()) as AudioFingerprint;
  if (!Array.isArray(reference.values) || reference.rate !== 20) return null;
  const response = await fetch(`/api/audio/${encodeURIComponent(trackId)}`);
  if (!response.ok) return null;
  const encoded = await response.arrayBuffer();
  // A low-rate offline decoder bounds memory while preserving the envelope used for matching.
  const context = new OfflineAudioContext(1, 1, 8000);
  const decoded = await context.decodeAudioData(encoded);
  const samples = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < samples.length; i++)
      samples[i] = samples[i]! + data[i]! / decoded.numberOfChannels;
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./video-sync.worker.ts", import.meta.url), {
      type: "module",
    });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("Video alignment timed out"));
    }, 30000);
    worker.onmessage = (event: MessageEvent<{ result?: VideoAlignment; error?: string }>) => {
      clearTimeout(timeout);
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.result?.confidence ? event.data.result : null);
    };
    worker.onerror = () => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error("Video alignment failed"));
    };
    worker.postMessage({ samples, sampleRate: decoded.sampleRate, reference }, [samples.buffer]);
  });
}
