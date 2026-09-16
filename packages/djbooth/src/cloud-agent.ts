import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { importProgressTracker, runCloudCommand, type ImportProgress } from "./cloud-worker.js";

/** Transport only: the agent chooses public CLI commands; master.db owns their workflow. */
export function cloudAgent(options: {
  id: string;
  source: string;
  endpoint?: string;
  save(): Promise<void>;
  progress(value: ImportProgress): void;
  signal: AbortSignal;
}) {
  let active:
    | {
        id: string;
        controller: AbortController;
        result: Record<string, unknown>;
        done: Promise<void>;
      }
    | undefined;
  const receipts = new Map<string, Record<string, unknown>>();
  let imported: { playlistId: string; entries: number } | undefined;
  const stages: NonNullable<ImportProgress["stages"]> = {};
  let latest: ImportProgress | undefined;
  const emit = (value: ImportProgress) => {
    if (value.phase === "download") {
      stages.resolve = { status: "complete", current: value.total, total: value.total };
    }
    if (["resolve", "download", "analyze", "enrich", "publish"].includes(value.phase)) {
      stages[value.phase] = { status: "running", current: value.current, total: value.total };
    }
    latest = { ...value, stages: structuredClone(stages) };
    options.progress(latest);
  };
  const complete = (phase: string, total: number) => {
    stages[phase] = { status: "complete", current: total, total };
  };
  return async (input: Record<string, unknown>): Promise<unknown> => {
    if (input.operation === "instructions")
      return {
        instructions: await readFile("/app/AGENTS.md", "utf8"),
        source: options.source,
        activeProcess: active?.result ?? null,
        recentReceipts: [...receipts.values()].slice(-10),
        imported: imported ?? null,
        progress: latest ?? null,
        dbPath: "/data/master.db",
        outputDirectory: "/data/audio",
        providerPlaylistFile: existsSync("/tmp/provider-playlist.json")
          ? "/tmp/provider-playlist.json"
          : null,
        endpoint: options.endpoint ?? "http://djbooth.internal",
        namespace: `cloud:${options.id}`,
        guidance:
          "If activeProcess is non-null, poll its process_id until terminal before starting anything. Reuse imported and recentReceipts to continue unfinished work across agent turns. Call with operation=start, a unique process_id, and args for the djbooth CLI (omit the executable). Use import with --db-path /data/master.db --output-directory /data/audio --reference-ytdlp --analysis-concurrency 2 --analysis-threads 2. Add --provider-playlist-file /tmp/provider-playlist.json only when providerPlaylistFile is non-null. After successful import, cloud publish with --playlist <returned playlistId> --db-path /data/master.db --endpoint http://djbooth.internal --namespace cloud:" +
          options.id +
          ". Poll the process until terminal; inspect errors and resume with the same CLI workflow. No phone connection is needed. Do not report success before publication is verified.",
      };
    const id = input.process_id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw new Error("Invalid process ID");
    if (input.operation === "poll") {
      if (active?.id === id) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          active.done,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 10_000);
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      return active?.id === id
        ? active.result
        : (receipts.get(id) ?? {
            status: "unknown",
            message:
              "Process was lost after a restart. Rerun the resumable CLI command with a new process ID.",
          });
    }
    if (input.operation === "cancel") {
      if (active?.id === id) active.controller.abort();
      return { status: "cancelling" };
    }
    if (input.operation !== "start") throw new Error("Invalid operation");
    if (active?.id === id) return active.result;
    if (receipts.has(id)) return receipts.get(id);
    if (active)
      return {
        ...active.result,
        message: "A command is already running. Poll this process_id before starting another.",
      };
    if (
      !Array.isArray(input.args) ||
      !input.args.length ||
      input.args.length > 100 ||
      input.args.some((v) => typeof v !== "string" || v.length > 4096 || v.includes("\0"))
    )
      throw new Error("Invalid CLI arguments");
    const args = input.args as string[];
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const process = {
      done,
      id,
      controller,
      result: { status: "running", process_id: id, diagnostics: "" } as Record<string, unknown>,
    };
    active = process;
    emit({
      status: "running",
      phase:
        args[0] === "enrich"
          ? "enrich"
          : args[0] === "cloud" && args[1] === "publish"
            ? "publish"
            : "resolve",
      current: 0,
      total: 0,
      message: `Agent running djbooth ${args[0]}`,
    });
    void (async () => {
      try {
        const progress = importProgressTracker();
        const result = await runCloudCommand(
          args,
          AbortSignal.any([controller.signal, options.signal]),
          (line) => {
            process.result.diagnostics = `${process.result.diagnostics}\n${line}`.slice(-12000);
            const update = progress(line);
            if (update)
              emit({
                status: "running",
                phase: "import",
                current: 0,
                total: 1,
                message: "Agent processing playlist",
                ...update,
              });
          },
          { DJBOOTH_CLOUD_TOKEN: "container-binding" },
        );
        await options.save();
        process.result = {
          status: "completed",
          process_id: id,
          result,
          diagnostics: process.result.diagnostics,
        };
        const value = result as Record<string, unknown>;
        if (
          args[0] === "import" &&
          args[1] === options.source &&
          typeof value.playlistId === "string" &&
          Number.isSafeInteger(value.entries) &&
          Number(value.entries) > 0
        ) {
          imported = { playlistId: value.playlistId, entries: Number(value.entries) };
          for (const phase of ["resolve", "download", "analyze"]) complete(phase, imported.entries);
          if (latest) {
            latest = { ...latest, stages: structuredClone(stages) };
            options.progress(latest);
          }
        }
        if (args[0] === "enrich" && imported) {
          complete("enrich", imported.entries);
          if (latest) {
            latest = { ...latest, stages: structuredClone(stages) };
            options.progress(latest);
          }
        }
        if (
          args[0] === "cloud" &&
          args[1] === "publish" &&
          imported &&
          !args.some((value) => value === "--dry-run" || value.startsWith("--dry-run=")) &&
          flag(args, "--endpoint") === (options.endpoint ?? "http://djbooth.internal") &&
          flag(args, "--namespace") === `cloud:${options.id}` &&
          flag(args, "--playlist") === imported.playlistId
        ) {
          const collectionID = `cloud:${options.id}:playlist:${imported.playlistId}`;
          const playlist =
            Array.isArray(value.playlists) && value.playlists.find((v) => v.id === collectionID);
          if (
            Array.isArray(value.failures) &&
            !value.failures.length &&
            Array.isArray(value.conflicts) &&
            !value.conflicts.length &&
            Number(value.tracks) > 0 &&
            value.availableAudio === value.tracks &&
            value.cdjReady === value.tracks &&
            playlist?.tracks === imported.entries
          ) {
            complete("publish", imported.entries);
            emit({
              status: "complete",
              phase: "complete",
              current: imported.entries,
              total: imported.entries,
              analysisVersion: 1,
              collectionID,
              message: `Published ${imported.entries} tracks`,
            });
          }
        }
      } catch (error) {
        await options.save().catch(() => undefined);
        process.result = {
          status: "failed",
          process_id: id,
          error: error instanceof Error ? error.message : "Command failed",
          diagnostics: process.result.diagnostics,
        };
      } finally {
        receipts.set(id, process.result);
        if (receipts.size > 100) receipts.delete(receipts.keys().next().value!);
        active = undefined;
        finish();
      }
    })();
    return process.result;
  };
}

function flag(args: string[], name: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name) value = args[index + 1];
    else if (args[index]!.startsWith(`${name}=`)) value = args[index]!.slice(name.length + 1);
  }
  return value;
}
