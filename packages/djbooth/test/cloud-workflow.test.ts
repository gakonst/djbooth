import { expect, test, vi } from "vitest";
import { cloudWorkflow } from "../src/cloud-workflow.js";

const paths = {
  dbPath: "/data/master.db",
  outputDirectory: "/data/audio",
  endpoint: "http://djbooth.internal",
  token: "container-binding",
  namespace: "cloud:job",
};
const imported = {
  playlistId: "17",
  dbPath: paths.dbPath,
  entries: 2,
  acquired: 2,
  skipped: 0,
  imported: 2,
  sourceSetFallbacks: 0,
};
const published = {
  tracks: 2,
  availableAudio: 2,
  cdjReady: 2,
  conflicts: [],
  failures: [],
  playlists: [{ id: "cloud:job:playlist:17", tracks: 2 }],
};
function setup() {
  const run = vi.fn(async (args: string[]) =>
    args[0] === "resolve"
      ? { entries: [{}, {}] }
      : args[0] === "import"
        ? imported
        : args[0] === "cloud"
          ? published
          : {},
  );
  const save = vi.fn(async () => {});
  const progress = vi.fn();
  const create = () =>
    cloudWorkflow({
      source: "https://soundcloud.com/artist/sets/list",
      paths,
      signal: new AbortController().signal,
      save,
      progress,
      run,
    });
  return { run, save, progress, create };
}
async function finish(exec: ReturnType<typeof cloudWorkflow>, input: Record<string, unknown>) {
  let receipt = await exec({ operation: "start", ...input });
  while (receipt.status === "running")
    receipt = await exec({ operation: "poll", process_id: receipt.process_id });
  return receipt;
}

test("phases use public commands and a lost response cannot start a second writer", async () => {
  const { create, run, save } = setup();
  const exec = create();
  let release!: () => void;
  save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = await exec({ operation: "start", stage: "resolve", process_id: "resolve-1" });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(first.status).toBe("running");
  expect(await exec({ operation: "start", stage: "resolve", process_id: "resolve-2" })).toEqual(
    first,
  );
  expect(run).toHaveBeenCalledTimes(1);
  release();
  expect((await exec({ operation: "poll", process_id: "resolve-1" })).status).toBe("completed");
  expect(
    (await exec({ operation: "start", stage: "resolve", process_id: "resolve-1" })).status,
  ).toBe("completed");
  expect(run).toHaveBeenCalledTimes(1);
});

test("publication after a container restart uses the durable import result and verifies every track", async () => {
  const { create, progress, run } = setup();
  const result = await finish(create(), { stage: "import", process_id: "import-1" });
  expect(result.result).toEqual(imported);
  const restored = create();
  expect((await restored({ operation: "poll", process_id: "import-1" })).status).toBe("unknown");
  const complete = await finish(restored, {
    stage: "publish",
    process_id: "publish-1",
    imported: result.result,
  });
  expect(complete.status).toBe("completed");
  expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
    status: "complete",
    current: 2,
    analysisVersion: 1,
  });
  run.mockResolvedValueOnce({ ...published, availableAudio: 1 } as any);
  const failed = await finish(restored, { stage: "publish", process_id: "publish-2", imported });
  expect(failed.status).toBe("failed");
});

test("snapshot failure does not acknowledge a completed workflow step", async () => {
  const { create, save } = setup();
  save.mockRejectedValue(new Error("R2 unavailable"));
  const result = await finish(create(), { stage: "resolve", process_id: "resolve-1" });
  expect(result).toMatchObject({ status: "failed", error: "R2 unavailable" });
});

test("import saves once and acknowledges only after the fresh workflow checkpoint", async () => {
  const { run } = setup();
  const legacyCheckpoint = vi.fn(async () => {});
  let release!: () => void;
  const save = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const progress = vi.fn();
  const exec = cloudWorkflow({
    source: "https://soundcloud.com/artist/sets/list",
    paths: { ...paths, checkpoint: legacyCheckpoint },
    signal: new AbortController().signal,
    save,
    progress,
    run,
  });
  const pending = await exec({ operation: "start", stage: "import", process_id: "import-1" });
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(legacyCheckpoint).not.toHaveBeenCalled();
  expect(pending.status).toBe("running");
  expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
    phase: "backup",
    stages: { analyze: { status: "complete", current: 2, total: 2 } },
  });
  release();
  expect((await exec({ operation: "poll", process_id: "import-1" })).status).toBe("completed");
  expect(save).toHaveBeenCalledTimes(1);
});

test("unverified tracklist research cannot advance the pipeline", async () => {
  const { create, run } = setup();
  run.mockResolvedValueOnce({ action: "agent-resolution-required" } as any);
  expect((await finish(create(), { stage: "resolve", process_id: "resolve-1" })).status).toBe(
    "failed",
  );
  expect(run).toHaveBeenCalledTimes(1);
});

test("explicit cloud refresh passes through to resolution without changing resume defaults", async () => {
  const { create, run } = setup();
  const exec = create();
  expect(await finish(exec, { stage: "resolve", process_id: "ordinary" })).toMatchObject({
    status: "completed",
    result: { entries: 2, refreshed: false },
  });
  expect(run.mock.calls[0]?.[0]).not.toContain("--refresh");
  expect(
    await finish(exec, { stage: "resolve", process_id: "refresh", refresh_resolution: true }),
  ).toMatchObject({
    status: "completed",
    result: { entries: 2, refreshed: true },
  });
  expect(run.mock.calls[1]?.[0]).toContain("--refresh");
});
