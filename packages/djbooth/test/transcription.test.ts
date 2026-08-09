import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { setupMuscriptor, transcribeAudioToMidi } from "../src/transcription.js";

const roots: Array<string> = [];

afterEach(() => {
  delete process.env.DJBOOTH_MUSCRIPTOR_FAKE_ARGS;
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fakeUv(root: string, payload: unknown): string {
  const executable = join(root, "uv");
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s\\n' "$@" > "$DJBOOTH_MUSCRIPTOR_FAKE_ARGS"
printf '%s\\n' "$UV_PROJECT_ENVIRONMENT" > "$DJBOOTH_MUSCRIPTOR_FAKE_ARGS.env"
printf '%s\\n' '${JSON.stringify(payload)}'
`,
  );
  chmodSync(executable, 0o755);
  return executable;
}

describe("MuScriptor MLX boundary", () => {
  it("sets up the pinned model through the locked uv project", async () => {
    const root = mkdtempSync(join(tmpdir(), "djbooth-muscriptor-test-"));
    roots.push(root);
    const argsPath = join(root, "args.txt");
    process.env.DJBOOTH_MUSCRIPTOR_FAKE_ARGS = argsPath;
    const uvBinary = fakeUv(root, {
      backend: "mlx",
      checkpoint: "/cache/muscriptor-large-mlx.safetensors",
      model: "MuScriptor/muscriptor-large",
      size: 123,
    });

    await expect(setupMuscriptor({ uvBinary })).resolves.toMatchObject({ backend: "mlx" });
    expect(readFileSync(argsPath, "utf8")).toContain("--locked\n--no-dev\npython");
    expect(readFileSync(argsPath, "utf8")).toContain("setup");
  });

  it("forwards transcription controls and returns typed artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "djbooth-muscriptor-test-"));
    roots.push(root);
    const argsPath = join(root, "args.txt");
    const audioPath = join(root, "input.wav");
    const midiPath = join(root, "output.mid");
    const eventsPath = join(root, "notes.json");
    writeFileSync(audioPath, "fixture");
    process.env.DJBOOTH_MUSCRIPTOR_FAKE_ARGS = argsPath;
    const uvBinary = fakeUv(root, {
      audioSeconds: 8,
      backend: "mlx",
      chunks: 1,
      events: eventsPath,
      generationSeconds: 2,
      instruments: ["Drums"],
      model: "MuScriptor/muscriptor-large",
      notes: 12,
      rawNotes: 13,
      output: midiPath,
      realtimeFactor: 0.25,
      totalSeconds: 3,
    });

    await expect(
      transcribeAudioToMidi(audioPath, midiPath, {
        durationSeconds: 8,
        eventsPath,
        instruments: ["Drums"],
        maxTokens: 512,
        startSeconds: 4,
        tempo: 126,
        uvBinary,
      }),
    ).resolves.toMatchObject({ notes: 12, output: midiPath });
    const args = readFileSync(argsPath, "utf8").split("\n");
    expect(args).toEqual(expect.arrayContaining(["transcribe", "--duration", "8"]));
    expect(args).toEqual(expect.arrayContaining(["--instrument", "Drums"]));
    expect(args).toEqual(expect.arrayContaining(["--max-tokens", "512"]));
    expect(args).toEqual(expect.arrayContaining(["--tempo", "126"]));
    expect(readFileSync(`${argsPath}.env`, "utf8")).toContain("muscriptor-mlx/python-3.12");
  });
});
