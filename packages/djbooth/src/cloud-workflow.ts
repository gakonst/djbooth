import { parseAgentTracklist } from "@gakonst/tracks";
import {
  importProgressTracker,
  prepareCloudImport,
  publishCloudImport,
  runCloudCommand,
  type CloudImportOptions,
  type CommandRunner,
  type ImportProgress,
} from "./cloud-worker.js";

/** Private container transport. Commands and paths are chosen here, never by a remote caller. */
export function cloudWorkflow(options: {
  source: string;
  paths: CloudImportOptions;
  signal: AbortSignal;
  save(): Promise<void>;
  progress(value: ImportProgress): void;
  run?: CommandRunner;
}) {
  type Receipt = { status: string; process_id: string; result?: unknown; error?: string };
  let active: { receipt: Receipt; done: Promise<void> } | undefined;
  const receipts = new Map<string, Receipt>();
  const stages: NonNullable<ImportProgress["stages"]> = {};
  const run = options.run ?? runCloudCommand;
  const emit = (value: ImportProgress) => {
    if (["resolve", "download", "analyze", "enrich", "publish"].includes(value.phase))
      stages[value.phase] = { status: "running", current: value.current, total: value.total };
    options.progress({ ...value, stages: structuredClone(stages) });
  };
  return async (input: Record<string, unknown>): Promise<Receipt> => {
    const id = input.process_id;
    if (typeof id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(id))
      throw new Error("Invalid process ID");
    if (input.operation === "poll") {
      if (active?.receipt.process_id === id) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          active.done,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 10_000);
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      return active?.receipt.process_id === id
        ? active.receipt
        : (receipts.get(id) ?? { status: "unknown", process_id: id });
    }
    if (
      input.operation !== "start" ||
      !["resolve", "import", "enrich", "publish"].includes(String(input.stage))
    )
      throw new Error("Invalid workflow stage");
    if (receipts.has(id)) return receipts.get(id)!;
    if (active) return active.receipt;
    const stage = String(input.stage);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const process = { receipt: { status: "running", process_id: id } as Receipt, done };
    active = process;
    const progress = importProgressTracker();
    const onLine = (line: string) => {
      const update = progress(line);
      if (update)
        emit({
          status: "running",
          phase: stage,
          current: 0,
          total: 1,
          message: "Processing recordings",
          ...update,
        });
    };
    emit({
      status: "running",
      phase: stage,
      current: 0,
      total: 1,
      message: {
        resolve: "Finding tracks",
        import: "Downloading and analyzing recordings",
        enrich: "Enriching recordings",
        publish: "Saving to your library",
      }[stage]!,
    });
    void (async () => {
      try {
        const { paths, signal } = options;
        let result: unknown;
        let completed: ImportProgress | undefined;
        if (stage === "resolve") {
          const args = [
            "resolve",
            options.source,
            "--db-path",
            paths.dbPath,
            "--output-directory",
            paths.outputDirectory,
          ];
          if (paths.providerPlaylistFile)
            args.push("--provider-playlist-file", paths.providerPlaylistFile);
          let manifest = (await run(args, signal, onLine)) as Record<string, any>;
          if (manifest.action === "agent-resolution-required") {
            if (!paths.resolve) throw new Error("Tracklist research is unavailable");
            const resolved = parseAgentTracklist(
              options.source,
              JSON.stringify(await paths.resolve(manifest, signal)),
            );
            manifest = (await run(
              [...args, "--agent-result-json", JSON.stringify(resolved)],
              signal,
              onLine,
            )) as Record<string, any>;
          }
          if (!Array.isArray(manifest.entries) || !manifest.entries.length)
            throw new Error("No verified tracks found for this source");
          result = { entries: manifest.entries.length };
          stages.resolve = {
            status: "complete",
            current: manifest.entries.length,
            total: manifest.entries.length,
          };
        } else if (stage === "import") {
          const imported = await prepareCloudImport(options.source, paths, signal, emit, run);
          result = imported;
          for (const phase of ["resolve", "download", "analyze"])
            stages[phase] = {
              status: "complete",
              current: imported.entries,
              total: imported.entries,
            };
        } else if (stage === "enrich") {
          await run(["enrich", "--db-path", paths.dbPath], signal, onLine);
          result = { enriched: true };
          stages.enrich = { status: "complete", current: 1, total: 1 };
        } else {
          const published = await publishCloudImport(input.imported, paths, signal, emit, run);
          if (published.status !== "complete") throw new Error(published.message);
          completed = published;
          result = published;
          stages.publish = { status: "complete", current: published.total, total: published.total };
        }
        // This must be a fresh snapshot AFTER the command, not an overlapping periodic backup.
        await options.save();
        process.receipt = { status: "completed", process_id: id, result };
        if (completed) options.progress({ ...completed, stages: structuredClone(stages) });
        else
          options.progress({
            status: "running",
            phase: stage,
            current: 1,
            total: 1,
            message: "Continuing download",
            stages: structuredClone(stages),
          });
      } catch (error) {
        await options.save().catch(() => undefined);
        process.receipt = {
          status: "failed",
          process_id: id,
          error: error instanceof Error ? error.message : "Processing failed",
        };
      } finally {
        receipts.set(id, process.receipt);
        if (receipts.size > 100) receipts.delete(receipts.keys().next().value!);
        active = undefined;
        finish();
      }
    })();
    return process.receipt;
  };
}
