import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { analyzeTrackAsync, type RekordboxAnalysisResult } from "@gakonst/rekordbox/analyzer";
import {
  separateStems,
  separateStemsBatch,
  type StemName,
  type StemsBatchJob,
  type StemsBatchResult,
  type StemsLayout,
  type StemsSeparationResult,
} from "@gakonst/rekordbox/stems";

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
  separateBatch?(
    jobs: StemsBatchJob[],
    stems: StemName[] | undefined,
    layout: StemsLayout,
  ): Promise<StemsBatchResult>;
};

type QueuedStemJob = {
  id: string;
  request: ProcessingJobRequest;
  track: TrackDetail;
};

const STEM_BATCH_WINDOW_MS = 50;

/** Own bounded analyzer/stems jobs and keep generated assets outside the source library. */
export class ProcessingJobManager {
  readonly #dependencies: ProcessingJobDependencies;
  readonly #jobs = new Map<string, ProcessingJob>();
  readonly #listeners = new Set<(job: ProcessingJob) => void>();
  readonly #stemQueue: QueuedStemJob[] = [];
  #analysisTail = Promise.resolve();
  #stemsTail = Promise.resolve();
  #stemBatchTimer: ReturnType<typeof setTimeout> | undefined;

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
    const stem = request.operation === "stems" ? (request.stem ?? "all") : undefined;
    const existing = this.list().find(
      (candidate) =>
        candidate.contentId === track.id &&
        candidate.operation === request.operation &&
        candidate.stem === stem &&
        (candidate.status === "queued" ||
          candidate.status === "running" ||
          (candidate.status === "completed" && artifactsExist(candidate, track.path!))),
    );
    if (existing) return existing;
    const job: ProcessingJob = {
      id: randomUUID(),
      contentId: track.id,
      trackTitle: track.title,
      operation: request.operation,
      ...(stem ? { stem } : {}),
      status: "queued",
      createdAt: new Date().toISOString(),
      message:
        request.operation === "stems" ? "Waiting for the MLX GPU queue" : "Waiting for analysis",
    };
    this.#jobs.set(job.id, job);
    this.#trim();
    this.#emit(job);
    if (
      request.operation === "stems" &&
      (!this.#dependencies.separate || this.#dependencies.separateBatch)
    ) {
      this.#stemQueue.push({ id: job.id, request, track });
      this.#scheduleStemBatch();
    } else {
      const lane = request.operation === "stems" ? this.#stemsTail : this.#analysisTail;
      const next = lane.then(() => this.#run(job.id, track, request)).catch(() => undefined);
      if (request.operation === "stems") this.#stemsTail = next;
      else this.#analysisTail = next;
    }
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
    const outputDirectory = processingOutputDirectory(track, request.operation);
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
      const cached = cachedStemArtifacts(outputDirectory, request.stem, track.path!);
      if (cached) {
        this.#update(id, {
          status: "completed",
          finishedAt: new Date().toISOString(),
          message: "Reused cached MLX stems",
          artifacts: cached.map((artifact) => ({
            ...artifact,
            url: `/api/processing/jobs/${encodeURIComponent(id)}/audio/${encodeURIComponent(artifact.stem)}`,
          })),
        });
        return;
      }
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
      this.#completeStemJob(id, result);
    } catch (error) {
      this.#update(id, {
        status: "failed",
        finishedAt: new Date().toISOString(),
        message: undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #scheduleStemBatch(): void {
    if (this.#stemBatchTimer) return;
    this.#stemBatchTimer = setTimeout(() => {
      this.#stemBatchTimer = undefined;
      const queued = this.#stemQueue.splice(0);
      for (const group of groupStemJobs(queued)) {
        this.#stemsTail = this.#stemsTail
          .then(() => this.#runStemBatch(group))
          .catch(() => undefined);
      }
    }, STEM_BATCH_WINDOW_MS);
  }

  async #runStemBatch(group: QueuedStemJob[]): Promise<void> {
    const pending = group.filter(({ id, request, track }) => {
      const outputDirectory = processingOutputDirectory(track, "stems");
      const cached = cachedStemArtifacts(outputDirectory, request.stem, track.path!);
      if (!cached) {
        this.#update(id, {
          status: "running",
          startedAt: new Date().toISOString(),
          outputDirectory,
          message:
            group.length > 1
              ? `Separating ${String(group.length)} tracks with one MLX model load`
              : "Separating on Apple GPU with MLX",
        });
        return true;
      }
      this.#update(id, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        outputDirectory,
        message: "Reused cached MLX stems",
        artifacts: cached.map((artifact) => ({
          ...artifact,
          url: processingAudioUrl(id, artifact.stem),
        })),
      });
      return false;
    });
    if (!pending.length) return;

    const layout = stemLayout(pending[0]!.request.stem);
    const stems = selectedStems(pending[0]!.request.stem);
    const jobs = pending.map(({ track }) => ({
      audioPath: track.path!,
      outputDirectory: processingOutputDirectory(track, "stems"),
    }));
    const separateBatch =
      this.#dependencies.separateBatch ??
      ((batchJobs: StemsBatchJob[], selected: StemName[] | undefined, batchLayout: StemsLayout) =>
        separateStemsBatch(batchJobs, {
          layout: batchLayout,
          force: true,
          stems: selected,
          uvBinary: process.env.REKORDBOX_STEMS_UV_BINARY,
        }));
    try {
      const batch = await separateBatch(jobs, stems, layout);
      if (batch.results.length !== pending.length)
        throw new Error(
          `MLX returned ${String(batch.results.length)} results for ${String(pending.length)} jobs`,
        );
      for (const [index, queued] of pending.entries())
        this.#completeStemJob(queued.id, batch.results[index]!, pending.length);
    } catch (error) {
      for (const { id } of pending) {
        this.#update(id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          message: undefined,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  #completeStemJob(id: string, result: StemsSeparationResult, batchSize = 1): void {
    this.#update(id, {
      status: "completed",
      finishedAt: new Date().toISOString(),
      message:
        batchSize > 1
          ? `MLX separation completed in ${result.processingSeconds.toFixed(1)}s; shared one model load across ${String(batchSize)} tracks`
          : `MLX separation completed in ${result.processingSeconds.toFixed(1)}s`,
      artifacts: result.outputs.map((artifact) => ({
        label: artifact.stem,
        stem: artifact.stem,
        path: artifact.path,
        url: processingAudioUrl(id, artifact.stem),
      })),
    });
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

function groupStemJobs(jobs: QueuedStemJob[]): QueuedStemJob[][] {
  const groups = new Map<ProcessingJobRequest["stem"], QueuedStemJob[]>();
  for (const job of jobs) {
    const key = job.request.stem ?? "all";
    const group = groups.get(key) ?? [];
    group.push(job);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function processingOutputDirectory(
  track: TrackDetail,
  operation: ProcessingJobRequest["operation"],
): string {
  const outputRoot = join(
    homedir(),
    "Music",
    "Rekordbox Derived",
    `${safeName(track.title || basename(track.path!))} [${safeName(track.id)}]`,
  );
  return join(outputRoot, operation);
}

function processingAudioUrl(id: string, stem: string): string {
  return `/api/processing/jobs/${encodeURIComponent(id)}/audio/${encodeURIComponent(stem)}`;
}

function stemLayout(stem: ProcessingJobRequest["stem"]): StemsLayout {
  return stem === "instrumental" ? "rekordbox" : "four-stem";
}

function selectedStems(stem: ProcessingJobRequest["stem"]): StemName[] | undefined {
  if (!stem || stem === "all") return undefined;
  return [stem];
}

function cachedStemArtifacts(
  outputDirectory: string,
  stem: ProcessingJobRequest["stem"],
  audioPath: string,
): Array<{ label: string; stem: string; path: string }> | undefined {
  const names =
    stem === "vocals"
      ? ["vocals"]
      : stem === "instrumental"
        ? ["instrumental"]
        : ["vocals", "drums", "bass", "other"];
  const artifacts = names.map((name) => ({
    label: name,
    stem: name,
    path: join(outputDirectory, `${name}.wav`),
  }));
  if (!artifacts.every((artifact) => existsSync(artifact.path))) return undefined;
  const sourceModifiedAt = statSync(audioPath).mtimeMs;
  return artifacts.every((artifact) => statSync(artifact.path).mtimeMs >= sourceModifiedAt)
    ? artifacts
    : undefined;
}

function artifactsExist(job: ProcessingJob, audioPath: string): boolean {
  if (!job.artifacts?.length || !job.artifacts.every((artifact) => existsSync(artifact.path)))
    return false;
  const sourceModifiedAt = statSync(audioPath).mtimeMs;
  return job.artifacts.every((artifact) => statSync(artifact.path).mtimeMs >= sourceModifiedAt);
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
