import { expect, test, vi } from "vitest";
import { diagnosticEvent, failureKind, telemetry, receiptFields } from "../src/telemetry";

test("telemetry drops secrets, arbitrary payloads and unbounded values", () => {
  const fields = {
    requestID: "11111111-1111-4111-8111-111111111111",
    stage: "import",
    durationMs: 12.7,
    prompt: "private prompt",
    token: "secret",
    source: "https://example.test/?token=secret",
    error: new Error("secret"),
    tool: "https://example.test/secret",
    current: Infinity,
    status: "x".repeat(500),
  };
  const value = diagnosticEvent("workflow_stage_failed", fields);
  expect(value).toEqual({
    event: "workflow_stage_failed",
    timeMs: expect.any(Number),
    requestID: fields.requestID,
    stage: "import",
    durationMs: 13,
  });
  expect(failureKind(new Error("Connection failed https://private.test/?token=secret"))).toBe(
    "transport",
  );
  expect(failureKind({ status: 403 })).toBe("authorization");
  const log = vi.spyOn(console, "log").mockImplementation(() => {
    throw new Error("sink unavailable");
  });
  try {
    expect(() => telemetry("test_event", fields)).not.toThrow();
  } finally {
    log.mockRestore();
  }
});

test("cloud action observations correlate job IDs without retaining receipt output", () => {
  const requestID = "11111111-1111-4111-8111-111111111111";
  const id = "22222222-2222-4222-8222-222222222222";
  const result = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          requestID,
          status: "completed",
          output: JSON.stringify({ id, source: "https://private.test/secret", message: "secret" }),
        }),
      },
    ],
  };
  expect(receiptFields(result)).toEqual({ requestID, status: "completed", importID: id });
  expect(receiptFields({ content: [{ type: "text", text: "not json" }] })).toBeNull();
  expect(
    receiptFields({
      content: [{ type: "text", text: JSON.stringify({ requestID, status: "private data" }) }],
    }),
  ).toBeNull();
});

test("invalid resolved state is distinguishable from internal runtime errors", () => {
  expect(
    failureKind(
      new Error(
        "resolve failed (INVALID_SOURCE): Invalid manifest at $.artifacts.analysis[0].mediaPath: must reference a downloaded recording",
      ),
    ),
  ).toBe("validation");
});
