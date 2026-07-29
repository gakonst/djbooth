import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diagnoseStems, separateStems } from "../src/index.js";

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
    });

    await expect(diagnoseStems({ uvBinary })).resolves.toMatchObject({
      backend: "mlx",
      convertedReady: true,
      device: "Device(gpu, 0)",
    });
    expect(readFileSync(argsPath, "utf8")).toContain("--locked\n--no-dev\npython");
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
    });

    await expect(
      separateStems(audioPath, outputDirectory, {
        cacheDirectory: join(root, "cache"),
        force: true,
        layout: "four-stem",
        uvBinary,
      }),
    ).resolves.toMatchObject({ backend: "mlx", layout: "four-stem" });
    const args = readFileSync(argsPath, "utf8").split("\n");
    expect(args).toContain("four-stem");
    expect(args).toContain("--force");
    expect(args).toContain("--cache-directory");
  });
});
