import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractClip, hasCompleteSampleCoverage, prepareMedia, sampleOffsets } from "./media.js";
import { mapConcurrent } from "./process.js";
import type { IdentifyOptions, RecognitionMoment } from "./types.js";

export const DEFAULT_RECOGNITION_CONCURRENCY = 3;
export const MAX_RECOGNITION_CONCURRENCY = 8;

export interface ClipRecognizer {
  recognizeClip(clip: Blob, scanSeconds: number, filename?: string): Promise<RecognitionMoment>;
}

export interface SampleRecognitionResult {
  moments: RecognitionMoment[];
  durationSeconds: number;
  title?: string;
  intervalSeconds: number;
  complete: boolean;
}

export async function recognizeSamples(
  source: string,
  recognizer: ClipRecognizer,
  options: IdentifyOptions = {},
): Promise<SampleRecognitionResult> {
  const intervalSeconds = options.intervalSeconds ?? 60;
  const clipSeconds = options.clipSeconds ?? 12;
  const concurrency = options.concurrency ?? DEFAULT_RECOGNITION_CONCURRENCY;
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_RECOGNITION_CONCURRENCY
  )
    throw new TypeError(
      `Recognition concurrency must be an integer between 1 and ${String(MAX_RECOGNITION_CONCURRENCY)}`,
    );
  const env = options.env ?? process.env;
  const media = await prepareMedia(source, {
    ...(options.signal ? { signal: options.signal } : {}),
    env,
  });
  let clipsDirectory: string | undefined;
  try {
    clipsDirectory = await mkdtemp(join(tmpdir(), "tracks-clips-"));
    const offsets = sampleOffsets(
      media.durationSeconds,
      intervalSeconds,
      clipSeconds,
      options.limit,
      options.startSeconds ?? 0,
    );
    let completed = 0;
    const moments = await mapConcurrent(offsets, concurrency, async (offset, index) => {
      const path = join(clipsDirectory!, `${String(index).padStart(6, "0")}.mp3`);
      try {
        await extractClip(media.path, path, offset, clipSeconds, {
          env,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        const bytes = await readFile(path);
        const moment = await recognizer.recognizeClip(
          new Blob([bytes], { type: "audio/mpeg" }),
          offset,
          `${index}.mp3`,
        );
        completed += 1;
        options.onProgress?.({
          phase: "recognize",
          current: completed,
          total: offsets.length,
          message: `Recognized sample ${completed}/${offsets.length}`,
        });
        return moment;
      } finally {
        await rm(path, { force: true });
      }
    });
    return {
      moments,
      durationSeconds: media.durationSeconds,
      ...(media.title ? { title: media.title } : {}),
      intervalSeconds,
      complete: hasCompleteSampleCoverage(offsets, media.durationSeconds, clipSeconds),
    };
  } finally {
    await Promise.all([
      ...(clipsDirectory ? [rm(clipsDirectory, { recursive: true, force: true })] : []),
      media.cleanup(),
    ]);
  }
}
