import { describe, expect, it } from "vitest";

import {
  relayCloseCode,
  responsesUpgradeHeaders,
  validateResponsesUpgrade,
} from "../src/server/responses-proxy.js";

describe("Nanocodex Responses relay", () => {
  it("does not forward synthetic WebSocket close codes onto the wire", () => {
    expect(relayCloseCode(1_000)).toBe(1_000);
    expect(relayCloseCode(4_001)).toBe(4_001);
    expect(relayCloseCode(1_005)).toBe(1_001);
    expect(relayCloseCode(1_006)).toBe(1_001);
  });

  it("accepts only same-origin upgrades with a bounded session ID", () => {
    expect(
      validateResponsesUpgrade({
        headers: {
          host: "127.0.0.1:4179",
          origin: "http://127.0.0.1:4179",
          upgrade: "websocket",
        },
        url: "/api/responses?session_id=session-1",
      }),
    ).toBeUndefined();
    expect(
      validateResponsesUpgrade({
        headers: {
          host: "127.0.0.1:4179",
          origin: "https://attacker.example",
          upgrade: "websocket",
        },
        url: "/api/responses?session_id=session-1",
      })?.status,
    ).toBe(403);
    expect(
      validateResponsesUpgrade({
        headers: {
          host: "127.0.0.1:4179",
          origin: "http://127.0.0.1:4179",
          upgrade: "websocket",
        },
        url: "/api/responses?session_id=bad%20session",
      })?.status,
    ).toBe(400);
  });

  it("puts account-scoped authorization only on the upstream request", () => {
    expect(
      responsesUpgradeHeaders(
        {
          mode: "chatgpt",
          bearer: "server-secret",
          upstreamUrl: "wss://chatgpt.example/responses",
          revision: 1,
          accountId: "account-1",
          fedramp: true,
        },
        "session-1",
      ),
    ).toMatchObject({
      Authorization: "Bearer server-secret",
      "ChatGPT-Account-ID": "account-1",
      "X-OpenAI-Fedramp": "true",
      "session-id": "session-1",
      "thread-id": "session-1",
    });
  });
});
