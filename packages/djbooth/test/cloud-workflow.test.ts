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

test("completed logical command survives lost acknowledgments across all retries", async () => {
  const { create, run, save } = setup();
  const exec = create();
  const command = { stage: "resolve", command_key: "workflow-a:resolve" };
  const first = await finish(exec, { ...command, process_id: "resolve-1" });
  for (let attempt = 2; attempt <= 91; attempt++)
    expect(await finish(exec, { ...command, process_id: `resolve-${attempt}` })).toEqual(first);
  expect(run).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledTimes(1);
});

test.each(["command", "snapshot"])("failed %s retries under a new attempt ID", async (failure) => {
  const { create, run, save } = setup();
  (failure === "command" ? run : save).mockRejectedValueOnce(new Error("temporary failure"));
  const exec = create();
  const command = { stage: "resolve", command_key: "workflow-a:resolve" };
  expect(await finish(exec, { ...command, process_id: "resolve-1" })).toMatchObject({
    status: "failed",
  });
  expect(await finish(exec, { ...command, process_id: "resolve-2" })).toMatchObject({
    status: "completed",
  });
  expect(run).toHaveBeenCalledTimes(2);
  expect(await exec({ operation: "poll", process_id: "resolve-1" })).toMatchObject({
    status: "failed",
  });
});

test("changed refresh intent and workflow identity never reuse completed resolution", async () => {
  const { create, run } = setup();
  const exec = create();
  const command = { stage: "resolve", command_key: "workflow-a:resolve" };
  await finish(exec, { ...command, process_id: "resolve-1" });
  await expect(
    finish(exec, { ...command, process_id: "resolve-1", refresh_resolution: true }),
  ).rejects.toThrow("different command");
  expect(
    await finish(exec, { ...command, process_id: "resolve-2", refresh_resolution: true }),
  ).toMatchObject({ result: { refreshed: true } });
  expect(run.mock.calls[1]?.[0]).toContain("--refresh");
  await finish(exec, { ...command, command_key: "workflow-b:resolve", process_id: "resolve-3" });
  expect(run).toHaveBeenCalledTimes(3);
});

test("active command attaches only matching intent", async () => {
  const { create, run, save } = setup();
  let release!: () => void;
  save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const exec = create();
  const command = { operation: "start", stage: "resolve", command_key: "workflow-a:resolve" };
  const first = await exec({ ...command, process_id: "resolve-1" });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(await exec({ ...command, process_id: "resolve-2" })).toEqual(first);
  await expect(
    exec({ ...command, process_id: "resolve-1", refresh_resolution: true }),
  ).rejects.toThrow("different command");
  await expect(
    exec({ ...command, process_id: "resolve-3", refresh_resolution: true }),
  ).rejects.toThrow("Another workflow command");
  release();
  expect(await exec({ operation: "poll", process_id: first.process_id })).toMatchObject({
    status: "completed",
  });
  expect(await exec({ ...command, process_id: "resolve-4" })).toMatchObject({
    status: "completed",
    process_id: first.process_id,
  });
  expect(run).toHaveBeenCalledTimes(1);
});

test("publish fingerprint ignores object order but distinguishes imported results", async () => {
  const { create, run, save } = setup();
  const exec = create();
  const command = { stage: "publish", command_key: "workflow-a:publish", imported };
  const first = await finish(exec, { ...command, process_id: "publish-1" });
  expect(first.status).toBe("completed");
  expect(
    await finish(exec, {
      ...command,
      process_id: "publish-2",
      imported: Object.fromEntries(Object.entries(imported).reverse()),
    }),
  ).toEqual(first);
  await expect(
    finish(exec, {
      ...command,
      process_id: "publish-1",
      imported: { ...imported, playlistId: "18" },
    }),
  ).rejects.toThrow("different command");
  await finish(exec, {
    ...command,
    process_id: "publish-3",
    imported: { ...imported, playlistId: "18" },
  });
  expect(run).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenCalledTimes(2);
});

test("legacy commands retain process-ID replay and active attachment behavior", async () => {
  const { create, run, save } = setup();
  const exec = create();
  let release!: () => void;
  save.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const first = await exec({ operation: "start", stage: "resolve", process_id: "legacy-1" });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(await exec({ operation: "start", stage: "enrich", process_id: "legacy-2" })).toEqual(
    first,
  );
  release();
  const completed = await exec({ operation: "poll", process_id: "legacy-1" });
  expect(await finish(exec, { stage: "enrich", process_id: "legacy-1" })).toEqual(completed);
  await finish(exec, { stage: "resolve", process_id: "legacy-3" });
  expect(run).toHaveBeenCalledTimes(2);
});
