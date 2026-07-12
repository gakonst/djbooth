import { describe, expect, test } from "vitest";

import {
  hasCompleteSampleCoverage,
  isSupportedDownloadUrl,
  prepareMedia,
  sampleOffsets,
} from "../src/media.js";

describe("sampleOffsets", () => {
  test("adds a tail sample when the regular grid does not cover the end", () => {
    expect(sampleOffsets(300, 60, 12)).toEqual([0, 60, 120, 180, 240, 288]);
  });

  test("keeps the tail under a non-binding limit", () => {
    expect(sampleOffsets(300, 60, 12, 100)).toEqual([0, 60, 120, 180, 240, 288]);
    expect(sampleOffsets(300, 60, 12, 5)).toEqual([0, 60, 120, 180, 240]);
  });

  test("does not duplicate a rounded tail", () => {
    expect(sampleOffsets(24.0004, 12, 12)).toEqual([0, 12]);
  });

  test("handles media shorter than one clip", () => {
    expect(sampleOffsets(5.3, 60, 12)).toEqual([0]);
  });

  test.each([
    [60, 0, 12, undefined, 0],
    [60, 60, 0, undefined, 0],
    [60, 60, 12, 0, 0],
    [60, 60, 12, undefined, 120],
  ])("rejects invalid schedule %j", (duration, interval, clip, limit, start) => {
    expect(() => sampleOffsets(duration, interval, clip, limit, start)).toThrow();
  });
});

describe("sample coverage", () => {
  test("uses the actual schedule rather than whether a limit was supplied", () => {
    expect(hasCompleteSampleCoverage([0], 5.3, 12)).toBe(true);
    expect(hasCompleteSampleCoverage([0, 12, 24, 28], 40, 12)).toBe(true);
    expect(hasCompleteSampleCoverage([0, 60], 72, 12)).toBe(false);
    expect(hasCompleteSampleCoverage([12, 24], 36, 12)).toBe(false);
  });
});

describe("remote download allowlist", () => {
  test("allows set platforms and rejects generic/internal URLs", () => {
    expect(isSupportedDownloadUrl("https://youtu.be/id")).toBe(true);
    expect(isSupportedDownloadUrl("https://soundcloud.com/dj/set")).toBe(true);
    expect(isSupportedDownloadUrl("http://127.0.0.1/admin")).toBe(false);
    expect(isSupportedDownloadUrl("https://cdn.example.com/set.mp3")).toBe(false);
  });

  test("never prepares a remote set by downloading it", async () => {
    await expect(prepareMedia("https://youtube.com/watch?v=set", { env: {} })).rejects.toThrow(
      /Remote sample recognition is disabled/,
    );
  });
});
