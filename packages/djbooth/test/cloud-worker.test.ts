import { describe, expect, test, vi } from "vitest";
import { CloudProcessingError, importProgress, processCloudImport } from "../src/cloud-worker.js";
const options = {
  dbPath: "/data/master.db",
  endpoint: "https://library.test",
  token: "private-token",
  namespace: "cloud:12345678-1234-1234-1234-123456789abc",
  outputDirectory: "/data/audio",
};
const imported = { playlistId: "17", dbPath: "/data/master.db", entries: 3, sourceSetFallbacks: 1 };
const published = {
  tracks: 3,
  availableAudio: 3,
  cdjReady: 3,
  conflicts: [],
  failures: [],
  playlists: [{ id: `${options.namespace}:playlist:17`, tracks: 3 }],
};
describe("playlist container pipeline", () => {
  test("keeps playlist counters while per-track analysis overlaps downloads", async () => {
    const progress = vi.fn();
    const run = vi.fn(async (args, _signal, onLine) => {
      if (args[0] !== "import") return published;
      onLine("[acquisition] progress: 13/50 recordings processed");
      onLine("[analysis] completed 1/1 track.m4a");
      expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({
        phase: "download",
        current: 13,
        total: 50,
        message: "Downloading and analyzing recordings",
      });
      onLine("[acquisition] progress: 50/50 recordings processed");
      onLine("[analysis] started 0/1 final.m4a");
      expect(progress.mock.calls.at(-1)?.[0].phase).toBe("analyze");
      return imported;
    });
    await processCloudImport(
      "https://open.spotify.com/playlist/example",
      options,
      new AbortController().signal,
      progress,
      run,
    );
  });
  test("does not reinterpret a hosted playlist download failure as a DJ set", async () => {
    const error = new CloudProcessingError("import failed: HTTP 403");
    const run = vi.fn().mockRejectedValue(error);
    const resolve = vi.fn();
    await expect(
      processCloudImport(
        "https://open.spotify.com/playlist/example",
        { ...options, providerPlaylistFile: "/tmp/playlist.json", resolve },
        new AbortController().signal,
        vi.fn(),
        run,
      ),
    ).rejects.toBe(error);
    expect(run).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    expect(run.mock.calls[0]![0]).toContain("--reference-ytdlp");
  });
  test("cloud backfill attaches artifacts without replacing mobile library edits", async () => {
    const run = vi.fn().mockResolvedValueOnce(imported).mockResolvedValueOnce(published);
    const result = await processCloudImport(
      "https://youtu.be/example",
      { ...options, artifactsOnly: true },
      new AbortController().signal,
      () => {},
      run,
    );
    expect(run.mock.calls[1]![0]).toContain("--artifacts-only");
    expect(result).toMatchObject({ status: "complete", analysisVersion: 1 });
  });
  test("recovers a blocked provider using the saved playlist and a verified alternate upload", async () => {
    const source = "https://youtube.com/watch?v=example";
    const alternate = "https://soundcloud.com/publisher/same-set";
    const run = vi
      .fn()
      .mockRejectedValueOnce(new CloudProcessingError("import failed: HTTP 403"))
      .mockResolvedValueOnce({
        source: { title: "Same set", durationSeconds: 600 },
        tracklist: { url: "https://set79.com/tracklist/soundcloud.com/publisher/same-set" },
      })
      .mockResolvedValueOnce(imported)
      .mockResolvedValueOnce(published);
    const resolve = vi.fn().mockResolvedValue({ url: alternate });
    const result = await processCloudImport(
      source,
      { ...options, resolve },
      new AbortController().signal,
      vi.fn(),
      run,
    );
    expect(result.status).toBe("complete");
    expect(run.mock.calls[1]![0][0]).toBe("resolve");
    expect(resolve.mock.calls[0]![0]).toMatchObject({ action: "source-recovery-required", source });
    expect(run.mock.calls[2]![0]).toContain("--source-set-download-url");
    expect(run.mock.calls[2]![0]).toContain(alternate);
    expect(run.mock.calls[2]![0]).not.toContain("--whole-set");
  });
  test("runs import then publishes its exact playlist with isolated IDs and reports set extracts", async () => {
    const run = vi.fn().mockResolvedValueOnce(imported).mockResolvedValueOnce(published);
    const progress = vi.fn();
    const result = await processCloudImport(
      "https://soundcloud.com/artist/sets/list",
      { ...options, providerPlaylistFile: "/tmp/provider-playlist.json" },
      new AbortController().signal,
      progress,
      run,
    );
    expect(run.mock.calls[0]![0]).toContain("import");
    const inputIndex = run.mock.calls[0]![0].indexOf("--provider-playlist-file");
    expect(inputIndex).toBeGreaterThan(0);
    expect(run.mock.calls[0]![0][inputIndex + 1]).toBe("/tmp/provider-playlist.json");
    expect(run.mock.calls[0]![0]).not.toContain("--whole-set");
    expect(run.mock.calls[1]![0]).toEqual([
      "cloud",
      "publish",
      "--endpoint",
      options.endpoint,
      "--playlist",
      "17",
      "--namespace",
      options.namespace,
      "--db-path",
      options.dbPath,
    ]);
    expect(run.mock.calls[1]![0]).not.toContain(options.token);
    expect(run.mock.calls[1]![3]).toEqual({ DJBOOTH_CLOUD_TOKEN: options.token });
    expect(result.status).toBe("complete");
    expect(result.message).toContain("1 set extracts");
    expect(result.collectionID).toBe(`${options.namespace}:playlist:17`);
    expect(progress.mock.calls.some(([p]) => p.phase === "publish")).toBe(true);
  });
  test.each([
    { ...published, failures: [{ id: "3" }] },
    { ...published, conflicts: ["track:3"] },
    { ...published, availableAudio: 2 },
    { ...published, tracks: 2 },
    { ...published, cdjReady: 2 },
  ])("does not report completion for incomplete publication", async (result) => {
    const run = vi.fn().mockResolvedValueOnce(imported).mockResolvedValueOnce(result);
    expect(
      (
        await processCloudImport(
          "https://youtu.be/example",
          options,
          new AbortController().signal,
          () => {},
          run,
        )
      ).status,
    ).toBe("failed");
  });
  test("repeated recordings preserve playlist positions without requiring duplicate audio uploads", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(imported)
      .mockResolvedValueOnce({ ...published, tracks: 2, availableAudio: 2, cdjReady: 2 });
    expect(
      (
        await processCloudImport(
          "https://youtu.be/example",
          options,
          new AbortController().signal,
          () => {},
          run,
        )
      ).status,
    ).toBe("complete");
  });
  test("backs up stable playlist IDs before publishing any cloud entities", async () => {
    const events: string[] = [];
    const run = vi.fn(async (args: string[]) => {
      events.push(args[0]!);
      return args[0] === "import" ? imported : published;
    });
    await processCloudImport(
      "https://youtu.be/example",
      {
        ...options,
        checkpoint: async () => {
          events.push("backup");
        },
      },
      new AbortController().signal,
      () => {},
      run,
    );
    expect(events).toEqual(["import", "backup", "cloud"]);
  });
  test("a resolution handoff cannot become an empty successful playlist", async () => {
    const run = vi.fn().mockResolvedValue({ status: "needs-agent" });
    await expect(
      processCloudImport(
        "https://youtu.be/example",
        options,
        new AbortController().signal,
        () => {},
        run,
      ),
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
  test("researches a resolution handoff, resumes import, and publishes", async () => {
    const source = "https://youtube.com/watch?v=example";
    const handoff = { action: "agent-resolution-required", source, context: { title: "A set" } };
    const resolve = vi.fn().mockResolvedValue({
      source,
      provider: "agent",
      complete: false,
      tracks: [{ order: 1, startSeconds: 0, artist: "Artist", title: "Recording" }],
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce(handoff)
      .mockResolvedValueOnce(imported)
      .mockResolvedValueOnce(published);
    const result = await processCloudImport(
      source,
      { ...options, resolve },
      new AbortController().signal,
      () => {},
      run,
    );
    expect(resolve).toHaveBeenCalledOnce();
    expect(run.mock.calls[1]![0]).toContain("--agent-result-json");
    expect(result.status).toBe("complete");
  });
  test("rejects a researched tracklist for a different performance before acquisition", async () => {
    const run = vi.fn().mockResolvedValue({ action: "agent-resolution-required" });
    const resolve = vi.fn().mockResolvedValue({
      source: "https://youtube.com/watch?v=wrong",
      provider: "agent",
      complete: true,
      tracks: [{ order: 1, startSeconds: 0, artist: "Artist", title: "Recording" }],
    });
    await expect(
      processCloudImport(
        "https://youtube.com/watch?v=example",
        { ...options, resolve },
        new AbortController().signal,
        () => {},
        run,
      ),
    ).rejects.toThrow("exactly match");
    expect(run).toHaveBeenCalledOnce();
  });
  test("progress extracts only bounded counters and known phases", () => {
    expect(
      importProgress("[acquisition] progress: 13/50 recordings processed (pass 1 of 2)"),
    ).toEqual({
      phase: "download",
      current: 13,
      total: 50,
      message: "Downloading recordings",
    });
    expect(importProgress("[analysis] secret provider URL https://private.test 2/10")).toEqual({
      phase: "analyze",
      current: 2,
      total: 10,
      message: "Analyzing recordings",
    });
    expect(importProgress("[analysis] 20/10")).toBeUndefined();
    expect(importProgress("secret credentials")).toBeUndefined();
  });
});
