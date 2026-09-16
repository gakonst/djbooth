import { expect, test, vi } from "vitest";
import { cloudAgent } from "../src/cloud-agent.js";
import { runCloudCommand } from "../src/cloud-worker.js";
vi.mock("../src/cloud-worker.js", async (original) => ({
  ...(await original<typeof import("../src/cloud-worker.js")>()),
  runCloudCommand: vi.fn(),
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
