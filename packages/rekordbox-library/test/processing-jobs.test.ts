import { describe, expect, it, vi } from "vitest";

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

  it("deduplicates equivalent work while it is queued or running", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new ProcessingJobManager({
      getTrack: () => track,
      separate: async (_audioPath, outputDirectory) => {
        await pending;
        return stemsResult(outputDirectory);
      },
    });

    const first = manager.start({ contentId: track.id, operation: "stems", stem: "vocals" });
    const duplicate = manager.start({ contentId: track.id, operation: "stems", stem: "vocals" });
    expect(duplicate.id).toBe(first.id);
    expect(manager.list()).toHaveLength(1);
    release();
    await waitFor(() => manager.get(first.id).status === "completed");
  });

  it("runs analysis and the MLX GPU lane independently", async () => {
    let releaseAnalysis!: () => void;
    const analysisPending = new Promise<void>((resolve) => {
      releaseAnalysis = resolve;
    });
    let stemsStarted = false;
    const manager = new ProcessingJobManager({
      getTrack: () => track,
      analyze: async (_audioPath, outputDirectory) => {
        await analysisPending;
        return {
          analysisDirectory: outputDirectory,
          backend: "clean-room-test",
          outputs: [],
          timing: { totalMs: 1 },
          timings: { totalMs: 1 },
        } as never;
      },
      separate: async (_audioPath, outputDirectory) => {
        stemsStarted = true;
        return stemsResult(outputDirectory);
      },
    });

    const analysis = manager.start({ contentId: track.id, operation: "analyze" });
    manager.start({ contentId: track.id, operation: "stems", stem: "vocals" });
    await waitFor(() => stemsStarted);
    expect(manager.get(analysis.id).status).toBe("running");
    releaseAnalysis();
    await waitFor(() => manager.get(analysis.id).status === "completed");
  });

  it("coalesces rapid compatible stem jobs into one model-loading batch", async () => {
    const secondTrack = {
      ...track,
      id: "track-43",
      title: "Night Drive Two",
      path: "/music/night-drive-two.wav",
    };
    const separateBatch = vi.fn(
      async (jobs: Array<{ audioPath: string; outputDirectory: string }>) => ({
        backend: "mlx" as const,
        layout: "four-stem" as const,
        model: "mel-band-roformer",
        modelLoadSeconds: 2.5,
        modelRevision: "pinned",
        processingSeconds: 8,
        results: jobs.map((job) => stemsResult(job.outputDirectory, job.audioPath)),
        selectedStems: ["vocals" as const],
        trackCount: jobs.length,
      }),
    );
    const manager = new ProcessingJobManager({
      getTrack: (id) => (id === secondTrack.id ? secondTrack : track),
      separateBatch,
    });

    const first = manager.start({ contentId: track.id, operation: "stems", stem: "vocals" });
    const second = manager.start({
      contentId: secondTrack.id,
      operation: "stems",
      stem: "vocals",
    });
    await waitFor(
      () =>
        manager.get(first.id).status === "completed" &&
        manager.get(second.id).status === "completed",
    );

    expect(separateBatch).toHaveBeenCalledOnce();
    expect(separateBatch.mock.calls[0]![0]).toHaveLength(2);
    expect(manager.get(first.id).message).toContain("shared one model load across 2 tracks");
  });
});

function stemsResult(outputDirectory: string, audioPath = track.path!) {
  return {
    audioPath,
    backend: "mlx" as const,
    device: "gpu",
    durationSeconds: 45,
    layout: "four-stem" as const,
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
    selectedStems: ["vocals" as const],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for processing job");
}
