import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diagnoseStems, separateStems, separateStemsBatch } from "../src/index.js";

const roots: Array<string> = [];

afterEach(() => {
  delete process.env.REKORDBOX_STEMS_FAKE_ARGS;
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fakeUv(root: string, payload: unknown): string {
  const executable = join(root, "uv");
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\\n' "$@" > "$REKORDBOX_STEMS_FAKE_ARGS"
printf '%s\\n' "$UV_PROJECT_ENVIRONMENT" > "$REKORDBOX_STEMS_FAKE_ARGS.env"
printf '%s\\n' '${JSON.stringify(payload)}'
`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

describe("MLX stems boundary", () => {
  it("reports structured doctor status through the pinned uv project", async () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-stems-test-"));
    roots.push(root);
    const argsPath = join(root, "args.txt");
    process.env.REKORDBOX_STEMS_FAKE_ARGS = argsPath;
    const uvBinary = fakeUv(root, {
      architecture: "arm64",
      backend: "mlx",
      cacheDirectory: "/cache",
      checkpointReady: true,
      configReady: true,
      convertedReady: true,
      device: "Device(gpu, 0)",
      macOS: "26.5.1",
      mlxAudioSeparatorVersion: "0.1.5",
      mlxVersion: "0.31.2",
      model: "model",
      modelRevision: "revision",
      python: "3.12.12",
      pythonEnvironment: "/cache/python-3.12",
    });

    await expect(diagnoseStems({ uvBinary })).resolves.toMatchObject({
      backend: "mlx",
      convertedReady: true,
      device: "Device(gpu, 0)",
    });
    expect(readFileSync(argsPath, "utf8")).toContain("--locked\n--no-dev\npython");
    expect(readFileSync(argsPath, "utf8")).not.toContain("--isolated");
  });

  it("forwards the selected output layout and force policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-stems-test-"));
    roots.push(root);
    const audioPath = join(root, "input.wav");
    const outputDirectory = join(root, "output");
    const argsPath = join(root, "args.txt");
    writeFileSync(audioPath, "fixture");
    process.env.REKORDBOX_STEMS_FAKE_ARGS = argsPath;
    const uvBinary = fakeUv(root, {
      audioPath,
      backend: "mlx",
      device: "Device(gpu, 0)",
      durationSeconds: 1,
      layout: "four-stem",
      model: "model",
      modelRevision: "revision",
      outputDirectory,
      outputs: [],
      processingSeconds: 1,
      reconstruction: { peakError: 0, rmsError: 0 },
      sampleRate: 44_100,
      selectedStems: ["vocals"],
    });

    await expect(
      separateStems(audioPath, outputDirectory, {
        cacheDirectory: join(root, "cache"),
        force: true,
        layout: "four-stem",
        stems: ["vocals"],
        uvBinary,
      }),
    ).resolves.toMatchObject({ backend: "mlx", layout: "four-stem" });
    const args = readFileSync(argsPath, "utf8").split("\n");
    expect(args).toContain("four-stem");
    expect(args).toContain("--force");
    expect(args).toContain("--cache-directory");
    expect(args).toContain("vocals");
    expect(readFileSync(`${argsPath}.env`, "utf8").trim()).toBe(join(root, "cache", "python-3.12"));
  });

  it("sends a bounded batch request and loads one helper process", async () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-stems-test-"));
    roots.push(root);
    const first = join(root, "first.wav");
    const second = join(root, "second.wav");
    const argsPath = join(root, "args.txt");
    writeFileSync(first, "fixture");
    writeFileSync(second, "fixture");
    process.env.REKORDBOX_STEMS_FAKE_ARGS = argsPath;
    const separation = (audioPath: string, outputDirectory: string) => ({
      audioPath,
      backend: "mlx",
      device: "Device(gpu, 0)",
      durationSeconds: 1,
      layout: "four-stem",
      model: "model",
      modelRevision: "revision",
      outputDirectory,
      outputs: [],
      processingSeconds: 1,
      reconstruction: { peakError: 0, rmsError: 0 },
      sampleRate: 44_100,
      selectedStems: ["vocals"],
    });
    const uvBinary = fakeUv(root, {
      backend: "mlx",
      layout: "four-stem",
      model: "model",
      modelLoadSeconds: 1,
      modelRevision: "revision",
      processingSeconds: 3,
      results: [separation(first, join(root, "one")), separation(second, join(root, "two"))],
      selectedStems: ["vocals"],
      trackCount: 2,
    });

    await expect(
      separateStemsBatch(
        [
          { audioPath: first, outputDirectory: join(root, "one") },
          { audioPath: second, outputDirectory: join(root, "two") },
        ],
        { layout: "four-stem", stems: ["vocals"], uvBinary },
      ),
    ).resolves.toMatchObject({ trackCount: 2, selectedStems: ["vocals"] });
    const args = readFileSync(argsPath, "utf8").trim().split("\n");
    const batchIndex = args.indexOf("batch");
    expect(batchIndex).toBeGreaterThan(-1);
    expect(args).toContain("vocals");
    expect(() => readFileSync(args[batchIndex + 1]!, "utf8")).toThrow();
  });
});
