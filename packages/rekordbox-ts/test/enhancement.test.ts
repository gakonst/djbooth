import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { diagnoseEnhancement, enhanceAudio, setupEnhancement } from "../src/index.js";

const roots: Array<string> = [];

afterEach(() => {
  delete process.env.REKORDBOX_ENHANCEMENT_FAKE_ARGS;
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fakeUv(root: string, payload: unknown): string {
  const executable = join(root, "uv");
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\\n' "$@" > "$REKORDBOX_ENHANCEMENT_FAKE_ARGS"
printf '%s\\n' "$UV_PROJECT_ENVIRONMENT" > "$REKORDBOX_ENHANCEMENT_FAKE_ARGS.env"
printf '%s\\n' '${JSON.stringify(payload)}'
`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

describe("A2SB MLX boundary", () => {
  it("reports structured readiness through the locked uv project", async () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-enhancement-test-"));
    roots.push(root);
    const argsPath = join(root, "args.txt");
    process.env.REKORDBOX_ENHANCEMENT_FAKE_ARGS = argsPath;
    const uvBinary = fakeUv(root, {
      architecture: "arm64",
      backend: "mlx",
      cacheDirectory: "/cache",
      checkpoints: [],
      device: "Device(gpu, 0)",
      license: "noncommercial",
      macOS: "26.5.1",
      mlxVersion: "0.31.2",
      model: "NVIDIA A2SB",
      modelRevision: "revision",
      python: "3.12.12",
      pythonEnvironment: "/cache/python-3.12",
    });

    await expect(diagnoseEnhancement({ uvBinary })).resolves.toMatchObject({
      backend: "mlx",
      device: "Device(gpu, 0)",
    });
    expect(readFileSync(argsPath, "utf8")).toContain("--locked\n--no-dev\npython");
  });

  it("selects and converts the requested release profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-enhancement-test-"));
    roots.push(root);
    const argsPath = join(root, "args.txt");
    process.env.REKORDBOX_ENHANCEMENT_FAKE_ARGS = argsPath;
    const uvBinary = fakeUv(root, {
      backend: "mlx",
      cacheDirectory: "/cache",
      license: "noncommercial",
      model: "NVIDIA A2SB",
      profile: "two-split",
      revision: "revision",
      weights: [],
    });

    await expect(
      setupEnhancement({ force: true, profile: "two-split", uvBinary }),
    ).resolves.toMatchObject({ backend: "mlx", profile: "two-split" });
    const args = readFileSync(argsPath, "utf8").split("\n");
    expect(args).toContain("two-split");
    expect(args).toContain("--force");
  });

  it("forwards restoration quality, stereo, and bounded-excerpt controls", async () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-enhancement-test-"));
    roots.push(root);
    const audioPath = join(root, "input.flac");
    const outputPath = join(root, "output.wav");
    const argsPath = join(root, "args.txt");
    writeFileSync(audioPath, "fixture");
    process.env.REKORDBOX_ENHANCEMENT_FAKE_ARGS = argsPath;
    const uvBinary = fakeUv(root, {
      backend: "mlx",
      channelMode: "mid-side",
      cutoffHz: 16_000,
      cutoffMethod: "explicit",
      detectedCutoffHz: 16_100,
      detectedRolloffHz: 15_900,
      device: "Device(gpu, 0)",
      durationSeconds: 10,
      inputPath: audioPath,
      model: "NVIDIA A2SB",
      modelRevision: "revision",
      ode: true,
      output: { path: outputPath, sha256: "abc", size: 123 },
      processingSeconds: 3,
      profile: "one-split",
      sampleRate: 44_100,
      seed: 7,
      startSeconds: 30,
      steps: 8,
    });

    await expect(
      enhanceAudio(audioPath, outputPath, {
        cutoffHz: 16_000,
        force: true,
        maxSeconds: 10,
        ode: true,
        profile: "one-split",
        seed: 7,
        startSeconds: 30,
        steps: 8,
        uvBinary,
      }),
    ).resolves.toMatchObject({ backend: "mlx", cutoffHz: 16_000, ode: true });
    const args = readFileSync(argsPath, "utf8").split("\n");
    expect(args).toContain("--max-seconds");
    expect(args).toContain("--force");
    expect(args).toContain("--start-seconds");
    expect(args).toContain("--cutoff-hz");
    expect(args).toContain("--ode");
    expect(readFileSync(`${argsPath}.env`, "utf8").trim()).toContain("enhancement/python-3.12");
  });
});
