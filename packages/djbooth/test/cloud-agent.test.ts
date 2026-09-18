import { expect, test, vi } from "vitest";
import { cloudAgent } from "../src/cloud-agent.js";
import { runCloudCommand } from "../src/cloud-worker.js";
vi.mock("../src/cloud-worker.js", async (original) => ({
  ...(await original<typeof import("../src/cloud-worker.js")>()),
  runCloudCommand: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readFile: vi.fn(async () => "Use the normal DJBooth CLI."),
}));
const source = "https://soundcloud.com/owner/sets/playlist";
const publishArgs = [
  "cloud",
  "publish",
  "--endpoint",
  "http://djbooth.internal",
  "--namespace",
  "cloud:11111111-1111-1111-1111-111111111111",
  "--playlist",
  "playlist",
];
const imported = { playlistId: "playlist", entries: 2 };
const id = "11111111-1111-1111-1111-111111111111";
const published = {
  tracks: 2,
  availableAudio: 2,
  cdjReady: 2,
  failures: [],
  conflicts: [],
  playlists: [{ id: `cloud:${id}:playlist:playlist`, tracks: 2 }],
};
function setup() {
  const progress = vi.fn();
  const save = vi.fn(async () => {});
  const exec = cloudAgent({
    id,
    source: "https://soundcloud.com/owner/sets/playlist",
    progress,
    save,
    signal: new AbortController().signal,
  });
  return { exec, progress, save };
}
async function finish(exec: ReturnType<typeof cloudAgent>, process_id: string) {
  let result: any;
  await vi.waitFor(async () => {
    result = await exec({ operation: "poll", process_id });
    expect(result.status).not.toBe("running");
  });
  return result;
}
test("agent starts real CLI commands once, checkpoints, and verifies complete publication", async () => {
  vi.mocked(runCloudCommand)
    .mockReset()
    .mockResolvedValueOnce(imported)
    .mockResolvedValueOnce(published);
  const { exec, progress, save } = setup();
  const start = {
    operation: "start",
    process_id: "import",
    args: ["import", "https://soundcloud.com/owner/sets/playlist", "--db-path", "/data/master.db"],
  };
  await exec(start);
  await exec(start);
  expect((await finish(exec, "import")).result).toEqual(imported);
  expect(runCloudCommand).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledOnce();
  expect(progress.mock.calls.some(([p]) => p.status === "complete")).toBe(false);
  await exec({
    operation: "start",
    process_id: "publish",
    args: publishArgs,
  });
  await finish(exec, "publish");
  expect(progress).toHaveBeenLastCalledWith(
    expect.objectContaining({ status: "complete", analysisVersion: 1, current: 2, total: 2 }),
  );
});
test("missing analysis or partial uploads cannot make the app show complete", async () => {
  vi.mocked(runCloudCommand)
    .mockReset()
    .mockResolvedValueOnce(imported)
    .mockResolvedValueOnce({ ...published, cdjReady: 1 });
  const { exec, progress } = setup();
  await exec({ operation: "start", process_id: "import", args: ["import", source] });
  await finish(exec, "import");
  await exec({ operation: "start", process_id: "publish", args: publishArgs });
  await finish(exec, "publish");
  expect(progress.mock.calls.some(([p]) => p.status === "complete")).toBe(false);
});
test("per-track analysis does not replace playlist download progress with 1/1", async () => {
  vi.mocked(runCloudCommand)
    .mockReset()
    .mockImplementationOnce(async (_args, _signal, line) => {
      line("[acquisition] progress: 12/50 recordings processed");
      line("[analysis] analyzed 1/1");
      return imported;
    });
  const { exec, progress } = setup();
  await exec({ operation: "start", process_id: "import", args: ["import", source] });
  await finish(exec, "import");
  expect(progress).toHaveBeenLastCalledWith(
    expect.objectContaining({
      phase: "download",
      current: 12,
      total: 50,
      message: "Downloading and analyzing recordings",
    }),
  );
});
test("failure preserves saved workflow, surfaces the error, and allows a new resumable command", async () => {
  vi.mocked(runCloudCommand)
    .mockReset()
    .mockRejectedValueOnce(new Error("Source unavailable"))
    .mockResolvedValueOnce(imported);
  const { exec, save } = setup();
  await exec({ operation: "start", process_id: "first", args: ["import", source] });
  expect(await finish(exec, "first")).toMatchObject({
    status: "failed",
    error: "Source unavailable",
  });
  expect(save).toHaveBeenCalledOnce();
  await exec({ operation: "start", process_id: "resume", args: ["import", source] });
  expect(await finish(exec, "resume")).toMatchObject({ status: "completed" });
});

test("dry-run publication and a different destination never complete the app download", async () => {
  for (const extra of [["--dry-run"], ["--endpoint", "https://different.example"]]) {
    vi.mocked(runCloudCommand)
      .mockReset()
      .mockResolvedValueOnce(imported)
      .mockResolvedValueOnce(published);
    const { exec, progress } = setup();
    await exec({ operation: "start", process_id: "import", args: ["import", source] });
    await finish(exec, "import");
    await exec({ operation: "start", process_id: "publish", args: [...publishArgs, ...extra] });
    await finish(exec, "publish");
    expect(progress.mock.calls.some(([p]) => p.status === "complete")).toBe(false);
  }
});

test("a new agent turn discovers and polls the existing CLI process without restarting it", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(runCloudCommand)
    .mockReset()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
  const { exec } = setup();
  await exec({ operation: "start", process_id: "running-import", args: ["import", source] });
  const instructions = (await exec({ operation: "instructions" })) as any;
  expect(instructions.activeProcess.process_id).toBe("running-import");
  expect(
    await exec({
      operation: "start",
      process_id: "accidental-duplicate",
      args: ["import", source],
    }),
  ).toMatchObject({ status: "running", process_id: "running-import" });
  expect(runCloudCommand).toHaveBeenCalledOnce();
  resolve(imported);
  await finish(exec, "running-import");
  const resumed = (await exec({ operation: "instructions" })) as any;
  expect(resumed.activeProcess).toBeNull();
  expect(resumed.imported).toEqual(imported);
  expect(resumed.recentReceipts).toEqual([
    expect.objectContaining({ process_id: "running-import", status: "completed" }),
  ]);
  expect(resumed.progress.stages).toMatchObject({
    download: { status: "complete" },
    analyze: { status: "complete" },
  });
});

test("managed agents can submit a full set tracklist as one literal CLI argument", async () => {
  vi.mocked(runCloudCommand).mockReset().mockResolvedValue({ entries: [] });
  const { exec } = setup();
  const tracklist = JSON.stringify({
    source,
    provider: "agent",
    complete: false,
    tracks: Array.from({ length: 34 }, (_, index) => ({
      order: index + 1,
      artist: "An evidenced artist from the performance",
      title: "An evidenced recording (Extended Unreleased Remix)",
      startSeconds: index * 180,
    })),
  });
  expect(tracklist.length).toBeGreaterThan(4096);
  const args = ["resolve", source, "--agent-result-json", tracklist];
  await exec({ operation: "start", process_id: "resolved-set", args });
  expect(await finish(exec, "resolved-set")).toMatchObject({ status: "completed" });
  expect(vi.mocked(runCloudCommand).mock.calls[0]?.[0]).toEqual(args);
  const instructions = (await exec({ operation: "instructions" })) as { guidance: string };
  expect(instructions.guidance).toContain("never exec_command");
});

test("large research payload allowance does not remove ordinary argument or transport bounds", async () => {
  vi.mocked(runCloudCommand).mockReset();
  for (const args of [
    ["resolve", "x".repeat(4097)],
    ["resolve", source, "--agent-result-json", "x".repeat(48_001)],
    ["resolve", source, "--agent-result-json", "\\".repeat(40_000)],
    ["resolve", source, "--agent-result-json", "invalid\0json"],
  ]) {
    const { exec } = setup();
    await expect(exec({ operation: "start", process_id: "invalid", args })).rejects.toThrow(
      "Invalid CLI arguments",
    );
  }
  expect(runCloudCommand).not.toHaveBeenCalled();
});
