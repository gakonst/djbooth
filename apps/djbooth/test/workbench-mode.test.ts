import { describe, expect, it } from "vitest";

import {
  assistantEnabledFromSearch,
  djBoothViewFromPath,
  workbenchUrl,
} from "../src/workbench-mode.js";

describe("agent-hosted workbench mode", () => {
  it("keeps the embedded assistant enabled by default", () => {
    expect(assistantEnabledFromSearch("")).toBe(true);
    expect(assistantEnabledFromSearch("?playlistId=42")).toBe(true);
  });

  it("recognizes assistant-free browser URLs", () => {
    expect(assistantEnabledFromSearch("?assistant=0")).toBe(false);
    expect(assistantEnabledFromSearch("?assistant=false&playlistId=42")).toBe(false);
  });

  it("builds a launch URL without discarding existing state", () => {
    expect(workbenchUrl("http://127.0.0.1:4179/?playlistId=42", false)).toBe(
      "http://127.0.0.1:4179/?playlistId=42&assistant=0",
    );
    expect(workbenchUrl("http://127.0.0.1:4179/?playlistId=42&assistant=0", true)).toBe(
      "http://127.0.0.1:4179/?playlistId=42",
    );
  });

  it("exposes library and live booth as views of one application", () => {
    expect(djBoothViewFromPath("/")).toBe("library");
    expect(djBoothViewFromPath("/booth")).toBe("booth");
    expect(djBoothViewFromPath("/booth/decks")).toBe("booth");
  });
});
