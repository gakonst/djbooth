import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadHardwareReplay } from "../src/replay.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("hardware replay", () => {
  it("uses one checkpoint, skips later snapshots, and bounds meter deltas to 30 Hz", async () => {
    const directory = mkdtempSync(join(tmpdir(), "djbooth-replay-test-"));
    temporaryDirectories.push(directory);
    const rows = [
      hardware("2026-08-09T20:59:59.000Z", snapshot(1)),
      hardware("2026-08-09T21:00:00.000Z", deck(2)),
      hardware("2026-08-09T21:00:00.010Z", meters(3)),
      hardware("2026-08-09T21:00:00.020Z", meters(4)),
      hardware("2026-08-09T21:00:00.040Z", meters(5)),
      hardware("2026-08-09T21:00:00.050Z", snapshot(6)),
      hardware("2026-08-09T21:00:01.000Z", event(7)),
    ];
    writeFileSync(
      join(directory, "events.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );

    const replay = await loadHardwareReplay({
      from: "2026-08-09T21:00:00.000Z",
      recording: directory,
      to: "2026-08-09T21:00:02.000Z",
    });

    expect(replay.durationMs).toBe(2_000);
    expect(replay.events.map(({ message }) => message.type)).toEqual([
      "snapshot",
      "deck",
      "meters",
      "meters",
      "event",
    ]);
    expect(replay.events.map(({ offsetMs }) => offsetMs)).toEqual([0, 0, 10, 40, 1_000]);
  });
});

function hardware(capturedAt: string, payload: Record<string, unknown>) {
  return { capturedAt, kind: "hardware", payload };
}

function snapshot(sequence: number) {
  return { type: "snapshot", schemaVersion: 1, snapshot: { sequence } };
}

function deck(sequence: number) {
  return { type: "deck", schemaVersion: 1, sequence, deck: { player: 2 } };
}

function meters(sequence: number) {
  return { type: "meters", schemaVersion: 1, sequence, meters: {} };
}

function event(sequence: number) {
  return { type: "event", schemaVersion: 1, sequence, event: { kind: "control" } };
}
