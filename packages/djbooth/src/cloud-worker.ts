import { spawn } from "node:child_process";

import { z } from "incur";
import { parseAgentTracklist } from "@gakonst/tracks";

export class CloudProcessingError extends Error {}

export type ImportProgress = {
  status: "running" | "complete" | "failed";
  phase: string;
  current: number;
  total: number;
  message: string;
  collectionID?: string;
  analysisVersion?: 1;
  stages?: Record<string, { status: "running" | "complete"; current: number; total: number }>;
};
export type CommandRunner = (
  args: string[],
  signal: AbortSignal,
  progress: (line: string) => void,
  environment?: Record<string, string>,
) => Promise<unknown>;
const importResult = z.object({
  playlistId: z.string().min(1),
  dbPath: z.string().min(1),
  entries: z.number().int().positive(),
  sourceSetFallbacks: z.number().int().nonnegative(),
});
const publishResult = z.object({
  tracks: z.number().int().nonnegative(),
  availableAudio: z.number().int().nonnegative(),
  cdjReady: z.number().int().nonnegative(),
  conflicts: z.array(z.string()),
  failures: z.array(z.unknown()),
  playlists: z.array(z.object({ id: z.string(), tracks: z.number().int().nonnegative() })),
});

/** Invoke the public umbrella CLI with argument arrays, never a shell or provider bypass. */
export const runCloudCommand: CommandRunner = (args, signal, progress, environment) =>
  new Promise((resolve, reject) => {
    const child = spawn("djbooth", [...args, "--progress", "always", "--format", "json"], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let output = "",
      diagnostics = "",
      pending = "",
      oversized = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (process.platform === "win32") child.kill(kind);
        else if (child.pid) process.kill(-child.pid, kind);
      } catch {
        /* already exited */
      }
    };
    const abort = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 5_000);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (output.length + chunk.length > 2 * 1024 * 1024) {
        oversized = true;
        abort();
      } else output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      diagnostics = (diagnostics + chunk).slice(-8192);
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop()!.slice(-4096);
      for (const line of lines) {
        try {
          progress(line);
        } catch {
          /* diagnostic callback */
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      if (signal.aborted || oversized || code !== 0) {
        if (diagnostics)
          process.stderr.write(diagnostics.replace(/https?:\/\/\S+/g, "[provider URL]"));
        let reason = "Processing command did not complete";
        try {
          const parsed = JSON.parse(output);
          const failure = parsed.error ?? parsed;
          if (
            typeof failure.code === "string" &&
            /^[A-Z_]+$/.test(failure.code) &&
            typeof failure.message === "string"
          ) {
            reason = `${args[0]} failed (${failure.code}): ${failure.message}`.replace(
              /https?:\/\/\S+/g,
              "[provider URL]",
            );
            for (const [key, value] of Object.entries({ ...process.env, ...environment }))
              if (/TOKEN|SECRET|PASSWORD|KEY/.test(key) && value && value.length >= 6)
                reason = reason.replaceAll(value, "[redacted]");
          }
        } catch {
          /* command did not return a structured error */
        }
        reject(new CloudProcessingError(reason.slice(0, 480)));
        return;
      }
      try {
        if (args.includes("--help") || args.includes("--llms-full")) {
          resolve({ text: output });
          return;
        }
        const parsed = JSON.parse(output);
        if (parsed.ok === false) throw new Error("Processing command failed");
        resolve(parsed.data ?? parsed);
      } catch (error) {
        reject(error);
      }
    });
  });

/** Only allowlisted phases/counts leave the container; provider diagnostics stay in container logs. */
export function importProgress(line: string): Partial<ImportProgress> | undefined {
  const publishing = /^cloud ([a-z-]+) (\d+)\/(\d+)/.exec(line);
  if (publishing)
    return {
      phase: "publish",
      current: Number(publishing[2]),
      total: Number(publishing[3]),
      message: "Saving to your library",
    };
  const stage =
    /\[(prepare|source-set|resolve|enrich|spotify|download|acquire|acquisition|analysis|analyze)(?::[a-z-]+)?\]/.exec(
      line,
    )?.[1];
  const count = /\b(\d+)\/(\d+)\b/.exec(line);
  if (!stage || (!count && !["prepare", "source-set"].includes(stage))) return;
  const current = count ? Number(count[1]) : 0,
    total = count ? Number(count[2]) : 1;
  if (!Number.isSafeInteger(total) || current > total) return;
  const phase =
    stage === "prepare"
      ? "import"
      : ["source-set", "acquire", "acquisition"].includes(stage)
        ? "download"
        : stage === "analysis"
          ? "analyze"
          : stage === "spotify"
            ? "enrich"
            : stage;
  return {
    phase,
    current,
    total,
    message: (
      {
        import: "Preparing import",
        resolve: "Finding tracks",
        enrich: "Matching recordings",
        download: "Downloading recordings",
        analyze: "Analyzing recordings",
      } as Record<string, string>
    )[phase]!,
  };
}

/** Keep per-recording analysis updates inside the playlist's overall progress. */
export function importProgressTracker() {
  let downloading: ReturnType<typeof importProgress>;
  return (line: string) => {
    const update = importProgress(line);
    if (update?.phase === "download") downloading = update;
    if (
      update?.phase === "analyze" &&
      downloading?.current !== undefined &&
      downloading.total !== undefined &&
      downloading.current < downloading.total
    )
      return { ...downloading, message: "Downloading and analyzing recordings" };
    return update;
  };
}

export type CloudImportOptions = {
  dbPath: string;
  endpoint: string;
  token: string;
  namespace: string;
  outputDirectory: string;
  artifactsOnly?: boolean;
  providerPlaylistFile?: string;
  checkpoint?: () => Promise<void>;
  resolve?: (request: unknown, signal: AbortSignal) => Promise<unknown>;
};

export async function processCloudImport(
  source: string,
  options: CloudImportOptions,
  signal: AbortSignal,
  progress: (value: ImportProgress) => void,
  run: CommandRunner = runCloudCommand,
): Promise<ImportProgress> {
  const imported = await prepareCloudImport(source, options, signal, progress, run);
  return publishCloudImport(imported, options, signal, progress, run);
}

export async function prepareCloudImport(
  source: string,
  options: CloudImportOptions,
  signal: AbortSignal,
  progress: (value: ImportProgress) => void,
  run: CommandRunner = runCloudCommand,
): Promise<z.infer<typeof importResult>> {
  const emit = (value: ImportProgress) => {
    try {
      progress(value);
    } catch {
      /* diagnostics cannot interrupt processing */
    }
  };
  emit({
    status: "running",
    phase: "import",
    current: 0,
    total: 1,
    message: "Importing in the cloud",
  });
  const args = [
    "import",
    source,
    "--db-path",
    options.dbPath,
    "--output-directory",
    options.outputDirectory,
    "--analysis-concurrency",
    "2",
    "--analysis-threads",
    "2",
    "--reference-ytdlp",
  ];
  if (options.providerPlaylistFile)
    args.push("--provider-playlist-file", options.providerPlaylistFile);
  const trackProgress = importProgressTracker();
  const onLine = (line: string) => {
    const update = trackProgress(line);
    if (update)
      emit({
        status: "running",
        phase: "import",
        current: 0,
        total: 1,
        message: "Importing in the cloud",
        ...update,
      });
  };
  const runImport = async (importArgs: string[]) => {
    try {
      return await run(importArgs, signal, onLine);
    } catch (error) {
      if (
        !(error instanceof CloudProcessingError) ||
        !/HTTP 403/.test(error.message) ||
        options.providerPlaylistFile ||
        !options.resolve
      )
        throw error;
      const manifest = await run(
        [
          "resolve",
          source,
          "--db-path",
          options.dbPath,
          "--output-directory",
          options.outputDirectory,
        ],
        signal,
        onLine,
      );
      const state = manifest as {
        source?: { title?: string; durationSeconds?: number };
        tracklist?: { url?: string };
      };
      if (!state.source?.durationSeconds || !state.tracklist?.url) throw error;
      emit({
        status: "running",
        phase: "resolve",
        current: 0,
        total: 1,
        message: "Finding another upload of this performance",
      });
      const alternate = (await options.resolve(
        {
          action: "source-recovery-required",
          source,
          context: { ...state.source, evidenceURL: state.tracklist.url },
        },
        signal,
      )) as { url?: string };
      const url = new URL(alternate.url ?? "");
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        ![
          "soundcloud.com",
          "www.soundcloud.com",
          "youtube.com",
          "www.youtube.com",
          "youtu.be",
        ].includes(url.hostname) ||
        url.href === source
      )
        throw error;
      // Resolution has already been committed; preserve any recordings acquired before failure.
      return run([...args, "--source-set-download-url", url.href], signal, onLine);
    }
  };
  let imported = await runImport(args);
  if (
    imported &&
    typeof imported === "object" &&
    "action" in imported &&
    imported.action === "agent-resolution-required"
  ) {
    emit({
      status: "running",
      phase: "resolve",
      current: 0,
      total: 1,
      message: "Researching the set tracklist",
    });
    if (!options.resolve)
      throw new CloudProcessingError("Cloud tracklist research is not configured.");
    const resolved = await options.resolve(imported, signal);
    const tracklist = parseAgentTracklist(source, JSON.stringify(resolved));
    // The umbrella command validates and saves this result in master.db before acquisition.
    imported = await runImport([...args, "--agent-result-json", JSON.stringify(tracklist)]);
  }
  const result = importResult.parse(imported);
  if (options.checkpoint) {
    emit({
      status: "running",
      phase: "backup",
      current: 0,
      total: 1,
      message: "Saving analyzed playlist",
    });
    await options.checkpoint();
  }
  return result;
}

export async function publishCloudImport(
  imported: unknown,
  options: CloudImportOptions,
  signal: AbortSignal,
  progress: (value: ImportProgress) => void,
  run: CommandRunner = runCloudCommand,
): Promise<ImportProgress> {
  const result = importResult.parse(imported);
  const emit = progress;
  const collectionID = `${options.namespace}:playlist:${result.playlistId}`;
  emit({
    status: "running",
    phase: "publish",
    current: 0,
    total: result.entries,
    message: "Uploading recordings",
    collectionID,
  });
  // Credentials are inherited from the processor environment, never placed in argv.
  const published = publishResult.parse(
    await run(
      [
        "cloud",
        "publish",
        "--endpoint",
        options.endpoint,
        "--playlist",
        result.playlistId,
        "--namespace",
        options.namespace,
        "--db-path",
        result.dbPath,
        ...(options.artifactsOnly ? ["--artifacts-only"] : []),
      ],
      signal,
      (line) => {
        const count = /^cloud (?:audio|metadata|audio-chunks) (\d+)\/(\d+)/.exec(line);
        if (count && Number(count[1]) <= Number(count[2]))
          emit({
            status: "running",
            phase: "publish",
            current: Number(count[1]),
            total: Number(count[2]),
            message: "Uploading recordings",
            collectionID,
          });
      },
      { DJBOOTH_CLOUD_TOKEN: options.token },
    ),
  );
  if (
    published.failures.length ||
    published.conflicts.length ||
    published.tracks === 0 ||
    published.availableAudio !== published.tracks ||
    published.cdjReady !== published.tracks ||
    published.playlists.find((playlist) => playlist.id === collectionID)?.tracks !== result.entries
  )
    return {
      status: "failed",
      phase: "failed",
      current: 0,
      total: 1,
      message: `Publishing needs attention: ${published.cdjReady}/${published.tracks} tracks have CDJ files, ${published.failures.length} upload failures, ${published.conflicts.length} conflicts. Retry to resume.`,
      collectionID,
    };
  return {
    status: "complete",
    phase: "complete",
    analysisVersion: 1,
    current: result.entries,
    total: result.entries,
    message: result.sourceSetFallbacks
      ? `Published ${result.entries} tracks, including ${result.sourceSetFallbacks} set extracts. Extract identifications may be uncertain.`
      : `Published ${result.entries} tracks`,
    collectionID,
  };
}
