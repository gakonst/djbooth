import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { analyzeTrackAsync, type RekordboxAnalysisResult } from "@gakonst/rekordbox/analyzer";
import { separateStems, type StemName, type StemsSeparationResult } from "@gakonst/rekordbox/stems";

import type { ProcessingJob, TrackDetail } from "../shared/types.js";

export type ProcessingJobRequest = {
  contentId: string;
  operation: "analyze" | "stems";
  stem?: "vocals" | "instrumental" | "all";
};

export type ProcessingJobDependencies = {
  analyze?(audioPath: string, outputDirectory: string): Promise<RekordboxAnalysisResult>;
  getTrack(contentId: string): TrackDetail;
  separate?(
    audioPath: string,
    outputDirectory: string,
    stems: StemName[] | undefined,
  ): Promise<StemsSeparationResult>;
};

/** Own bounded analyzer/stems jobs and keep generated assets outside the live Rekordbox library. */
export class ProcessingJobManager {
  readonly #dependencies: ProcessingJobDependencies;
  readonly #jobs = new Map<string, ProcessingJob>();
  readonly #listeners = new Set<(job: ProcessingJob) => void>();
  #tail = Promise.resolve();

  constructor(dependencies: ProcessingJobDependencies) {
    this.#dependencies = dependencies;
  }

  list(): ProcessingJob[] {
    return [...this.#jobs.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  get(id: string): ProcessingJob {
    const job = this.#jobs.get(id);
    if (!job) throw new RangeError(`Processing job '${id}' was not found`);
    return job;
  }

  start(request: ProcessingJobRequest): ProcessingJob {
    const track = this.#dependencies.getTrack(request.contentId);
    if (!track.path || !track.fileExists)
      throw new TypeError(`Track '${track.title}' does not have a readable local audio file`);
    const job: ProcessingJob = {
      id: randomUUID(),
      contentId: track.id,
      trackTitle: track.title,
      operation: request.operation,
      status: "queued",
      createdAt: new Date().toISOString(),
      message:
        request.operation === "stems" ? "Waiting for the MLX GPU queue" : "Waiting for analysis",
    };
    this.#jobs.set(job.id, job);
    this.#trim();
    this.#emit(job);
    this.#tail = this.#tail.then(() => this.#run(job.id, track, request)).catch(() => undefined);
    return job;
  }

  onChanged(listener: (job: ProcessingJob) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  resolveAudio(jobId: string, stem: string): string {
    const job = this.get(jobId);
    const artifact = job.artifacts?.find((candidate) => candidate.stem === stem);
    if (!artifact) throw new RangeError(`Stem '${stem}' was not found in job '${jobId}'`);
    return artifact.path;
  }

  async #run(id: string, track: TrackDetail, request: ProcessingJobRequest): Promise<void> {
    const outputRoot = join(
      homedir(),
      "Music",
      "Rekordbox Derived",
      `${safeName(track.title || basename(track.path!))} [${safeName(track.id)}]`,
    );
    const outputDirectory = join(outputRoot, request.operation);
    this.#update(id, {
      status: "running",
      startedAt: new Date().toISOString(),
      outputDirectory,
      message:
        request.operation === "stems"
          ? "Separating on Apple GPU with MLX"
          : "Running clean-room Rekordbox analysis",
    });
    try {
      if (request.operation === "analyze") {
        const analyze =
          this.#dependencies.analyze ??
          ((audioPath: string, destination: string) =>
            analyzeTrackAsync(audioPath, { outputDirectory: destination }));
        const result = await analyze(track.path!, outputDirectory);
        this.#update(id, {
          status: "completed",
          finishedAt: new Date().toISOString(),
          message: `Analysis completed in ${(result.timings.totalMs / 1_000).toFixed(1)}s`,
          artifacts: result.outputs.map(([path]) => ({ label: basename(path), path })),
        });
        return;
      }

      const selected = selectedStems(request.stem);
      const separate =
        this.#dependencies.separate ??
        ((audioPath: string, destination: string, stems: StemName[] | undefined) =>
          separateStems(audioPath, destination, {
            layout: request.stem === "instrumental" ? "rekordbox" : "four-stem",
            force: true,
            stems,
            uvBinary: process.env.REKORDBOX_STEMS_UV_BINARY,
          }));
      const result = await separate(track.path!, outputDirectory, selected);
      this.#update(id, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        message: `MLX separation completed in ${result.processingSeconds.toFixed(1)}s`,
        artifacts: result.outputs.map((artifact) => ({
          label: artifact.stem,
          stem: artifact.stem,
          path: artifact.path,
          url: `/api/processing/jobs/${encodeURIComponent(id)}/audio/${encodeURIComponent(artifact.stem)}`,
        })),
      });
    } catch (error) {
      this.#update(id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        message: undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #update(id: string, patch: Partial<ProcessingJob>): void {
    const current = this.get(id);
    const next = { ...current, ...patch };
    this.#jobs.set(id, next);
    this.#emit(next);
  }

  #emit(job: ProcessingJob): void {
    for (const listener of this.#listeners) listener(job);
  }

  #trim(): void {
    while (this.#jobs.size > 100) {
      const oldest = [...this.#jobs.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      )[0];
      if (!oldest || oldest.status === "running" || oldest.status === "queued") return;
      this.#jobs.delete(oldest.id);
    }
  }
}

function selectedStems(stem: ProcessingJobRequest["stem"]): StemName[] | undefined {
  if (!stem || stem === "all") return undefined;
  return [stem];
}

function safeName(value: string): string {
  return (
    value
      .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 120) || "track"
  );
}
