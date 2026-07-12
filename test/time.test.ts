import { describe, expect, test } from "vitest";

import { formatTimestamp, parseTimestamp, requireTimestamp } from "../src/time.js";

describe("timestamps", () => {
  test.each([
    ["90", 90],
    ["01:30", 90],
    ["1:02:03.5", 3723.5],
    [42.25, 42.25],
  ])("parses %s", (input, expected) => {
    expect(parseTimestamp(input)).toBe(expected);
  });

  test.each([
    "",
    "1:",
    ":30",
    "1::02",
    "-1:00",
    "00:60",
    "01:60:00",
    "1:2:3:4",
    "nope",
    -1,
    Number.NaN,
  ])("rejects %s", (input) => {
    expect(parseTimestamp(input)).toBeUndefined();
  });

  test("formats sortable hours", () => {
    expect(formatTimestamp(3723.9)).toBe("01:02:03");
  });

  test("reports accepted syntax", () => {
    expect(() => requireTimestamp("later")).toThrow(/seconds, MM:SS, or HH:MM:SS/);
  });
});
