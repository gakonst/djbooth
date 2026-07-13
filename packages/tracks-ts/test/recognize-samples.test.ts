import { describe, expect, test } from "vitest";

import {
  DEFAULT_RECOGNITION_CONCURRENCY,
  MAX_RECOGNITION_CONCURRENCY,
  recognizeSamples,
  type ClipRecognizer,
} from "../src/recognize-samples.js";

const unusedRecognizer: ClipRecognizer = {
  recognizeClip: () => Promise.reject(new Error("recognizer must not run")),
};

describe("sample recognition concurrency", () => {
  test("defaults to one full 30–60 track playlist wave", () => {
    expect(DEFAULT_RECOGNITION_CONCURRENCY).toBe(64);
    expect(MAX_RECOGNITION_CONCURRENCY).toBe(64);
  });

  test("rejects programmatic callers above the CLI cap before media work", async () => {
    await expect(
      recognizeSamples("/missing/set.wav", unusedRecognizer, { concurrency: 65 }),
    ).rejects.toThrow("Recognition concurrency must be an integer between 1 and 64");
  });
});
