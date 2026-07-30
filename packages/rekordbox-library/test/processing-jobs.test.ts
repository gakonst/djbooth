import { describe, expect, it } from "vitest";

import { ProcessingJobManager } from "../src/server/processing-jobs.js";
import type { TrackDetail } from "../src/shared/types.js";

const track = {
  id: "track-42",
  title: "Night Drive",
  path: "/music/night-drive.wav",
  fileExists: true,
} as TrackDetail;

describe("ProcessingJobManager", () => {
  it("runs a bounded MLX job and exposes only its declared audio artifacts", async () => {
    const manager = new ProcessingJobManager({
      getTrack: () => track,
      separate: async (_audioPath, outputDirectory) => ({
        audioPath: track.path!,
        backend: "mlx",
        device: "gpu",
        durationSeconds: 45,
        layout: "four-stem",
        model: "mel-band-roformer",
        modelRevision: "pinned",
        outputDirectory,
        outputs: [
          {
            channels: 2,
            frames: 1,
            path: `${outputDirectory}/vocals.wav`,
            sha256: "abc",
            size: 8,
            stem: "vocals",
          },
        ],
        processingSeconds: 3.2,
        reconstruction: { peakError: 0, rmsError: 0 },
        sampleRate: 44_100,
        selectedStems: ["vocals"],
      }),
    });

    const queued = manager.start({ contentId: track.id, operation: "stems", stem: "vocals" });
    expect(queued.status).toBe("queued");
    await waitFor(() => manager.get(queued.id).status === "completed");
    const completed = manager.get(queued.id);
    expect(completed.message).toBe("MLX separation completed in 3.2s");
    expect(manager.resolveAudio(queued.id, "vocals")).toMatch(/vocals\.wav$/u);
    expect(() => manager.resolveAudio(queued.id, "bass")).toThrowError("was not found");
  });

  it("rejects tracks without local audio before enqueuing work", () => {
    const manager = new ProcessingJobManager({
      getTrack: () => ({ ...track, path: null, fileExists: false }),
    });
    expect(() => manager.start({ contentId: track.id, operation: "analyze" })).toThrowError(
      "does not have a readable local audio file",
    );
    expect(manager.list()).toEqual([]);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for processing job");
}
