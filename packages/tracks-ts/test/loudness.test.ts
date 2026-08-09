import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  measureAudioLoudness,
  planLoudnessNormalization,
  type RekordboxLoudnessRecord,
} from "../src/loudness.js";

describe("loudness analysis", () => {
  test("parses ffmpeg loudnorm's EBU R128 and true-peak measurements", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-loudness-"));
    const audio = join(root, "recording.flac");
    const ffmpeg = join(root, "ffmpeg");
    await writeFile(audio, "fixture");
    await writeFile(
      ffmpeg,
      `#!/bin/sh
cat >&2 <<'JSON'
[Parsed_loudnorm_0] summary follows
{
  "input_i" : "-11.42",
  "input_tp" : "-0.31",
  "input_lra" : "5.70",
  "input_thresh" : "-21.58",
  "output_i" : "-22.91",
  "target_offset" : "-0.09"
}
JSON
`,
    );
    await chmod(ffmpeg, 0o755);

    await expect(measureAudioLoudness(audio, { ffmpeg })).resolves.toEqual({
      integratedLufs: -11.42,
      loudnessRangeLu: 5.7,
      truePeakDbtp: -0.31,
      thresholdLufs: -21.58,
    });
  });

  test("uses the collection median and limits static gain by true peak", () => {
    const records = [record("quiet", -12, -0.5), record("loud", -8, -3)];
    const plan = planLoudnessNormalization(records);

    expect(plan).toMatchObject({
      targetLufs: -10,
      targetSource: "median",
      truePeakCeilingDbtp: -1,
      measured: 2,
      ceilingLimited: 1,
    });
    expect(plan.entries[0]).toMatchObject({
      contentId: "quiet",
      requestedGainDb: 2,
      gainDb: -0.5,
      projectedTruePeakDbtp: -1,
      ceilingLimited: true,
    });
    expect(plan.entries[1]).toMatchObject({
      contentId: "loud",
      requestedGainDb: -2,
      gainDb: -2,
      projectedTruePeakDbtp: -5,
      ceilingLimited: false,
    });
  });

  test("accepts an explicit target without introducing compression or limiting", () => {
    const plan = planLoudnessNormalization([record("track", -10, -0.2)], {
      targetLufs: -14,
      truePeakCeilingDbtp: -1,
    });

    expect(plan.targetSource).toBe("explicit");
    expect(plan.entries[0]).toMatchObject({
      requestedGainDb: -4,
      gainDb: -4,
      projectedTruePeakDbtp: -4.2,
      ceilingLimited: false,
    });
  });
});

function record(contentId: string, integratedLufs: number, truePeakDbtp: number) {
  return {
    contentId,
    title: contentId,
    path: `/music/${contentId}.flac`,
    artifactSha256: contentId.padEnd(64, "0"),
    artifactSize: 1,
    artifactMtimeMs: 1,
    integratedLufs,
    loudnessRangeLu: 4,
    truePeakDbtp,
    thresholdLufs: integratedLufs - 10,
    measurementMethod: "ffmpeg-loudnorm-v1",
    measuredAt: "2026-08-09T00:00:00.000Z",
  } satisfies RekordboxLoudnessRecord;
}
