import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer } from "ws";

import {
  createResponsesCredentialProvider,
  type ResponsesCredential,
  type ResponsesCredentialProvider,
} from "./openai-auth.js";

const RESPONSES_WEBSOCKETS_BETA = "responses_websockets=2026-02-06";
const sessionPattern = /^[A-Za-z0-9._:-]{1,200}$/u;

export type ResponsesProxy = {
  close(): void;
};

/** Attach a same-origin browser-to-OpenAI WebSocket relay without exposing authorization. */
export function attachResponsesProxy(
  server: HttpServer,
  options: {
    apiKey?: string;
    credentials?: ResponsesCredentialProvider;
    upstreamUrl?: string;
  } = {},
): ResponsesProxy {
  const downstreamServer = new WebSocketServer({ noServer: true });
  const credentials =
    options.credentials ?? createResponsesCredentialProvider({ apiKey: options.apiKey });
  const sockets = new Set<WebSocket>();

  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const rejection = validateResponsesUpgrade(request);
    if (rejection) {
      console.error(
        `[responses-relay] downstream upgrade rejected: HTTP ${String(rejection.status)}`,
      );
      socket.end(
        `HTTP/1.1 ${String(rejection.status)} ${rejection.statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      return;
    }
    const sessionId = new URL(request.url!, `http://${request.headers.host}`).searchParams.get(
      "session_id",
    )!;
    void credentials
      .snapshot()
      .then((credential) => {
        if (socket.destroyed) return;
        downstreamServer.handleUpgrade(request, socket, head, (downstream) => {
          sockets.add(downstream);
          const pending: Array<{ data: Buffer; binary: boolean }> = [];
          let pendingBytes = 0;
          let upstream: WebSocket | undefined;
          let stopped = false;

          const fail = () => {
            if (downstream.readyState < WebSocket.CLOSING)
              downstream.close(1011, "Responses relay failed");
          };

          const connect = (snapshot: ResponsesCredential, retryUnauthorized: boolean) => {
            if (stopped) return;
            const candidate = new WebSocket(options.upstreamUrl ?? snapshot.upstreamUrl, {
              headers: responsesUpgradeHeaders(snapshot, sessionId),
            });
            upstream = candidate;
            sockets.add(candidate);
            let retrying = false;

            candidate.once("unexpected-response", (_request, response) => {
              response.resume();
              console.error(
                `[responses-relay] upstream upgrade rejected: HTTP ${String(response.statusCode ?? 0)}`,
              );
              if (response.statusCode === 401 && retryUnauthorized && snapshot.mode === "chatgpt") {
                retrying = true;
                sockets.delete(candidate);
                void credentials
                  .recoverUnauthorized(snapshot)
                  .then(() => credentials.snapshot())
                  .then((refreshed) => connect(refreshed, false))
                  .catch(fail);
                return;
              }
              fail();
            });
            candidate.once("open", () => {
              for (const frame of pending) candidate.send(frame.data, { binary: frame.binary });
              pending.length = 0;
              pendingBytes = 0;
            });
            candidate.on("message", (data, binary) => {
              if (downstream.readyState === WebSocket.OPEN) downstream.send(data, { binary });
            });
            candidate.once("close", (code, reason) => {
              sockets.delete(candidate);
              if (!retrying && downstream.readyState < WebSocket.CLOSING)
                closeSocket(downstream, code, reason.toString());
            });
            candidate.once("error", (error) => {
              console.error(`[responses-relay] upstream socket error: ${error.message}`);
              if (!retrying) fail();
            });
          };

          downstream.on("message", (data, binary) => {
            const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
            if (upstream?.readyState === WebSocket.OPEN) {
              upstream.send(frame, { binary });
              return;
            }
            pendingBytes += frame.byteLength;
            if (pending.length >= 128 || pendingBytes > 8 * 1024 * 1024) {
              downstream.close(1009, "WebSocket send queue exceeded its bound");
              upstream?.close();
              return;
            }
            pending.push({ data: frame, binary });
          });
          downstream.once("close", (code, reason) => {
            stopped = true;
            sockets.delete(downstream);
            if (upstream && upstream.readyState < WebSocket.CLOSING)
              closeSocket(upstream, code, reason.toString());
          });
          connect(credential, true);
        });
      })
      .catch((error: unknown) => {
        console.error(
          `[responses-relay] authorization unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!socket.destroyed)
          socket.end(
            "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
      });
  };

  server.on("upgrade", upgrade);
  return {
    close() {
      server.off("upgrade", upgrade);
      for (const socket of sockets) socket.close(1001, "Library server stopped");
      sockets.clear();
      downstreamServer.close();
    },
  };
}

export function validateResponsesUpgrade(
  request: Pick<IncomingMessage, "headers" | "url">,
): { status: number; statusText: string } | undefined {
  const host = request.headers.host;
  if (!host || !request.url) return { status: 400, statusText: "Bad Request" };
  const url = new URL(request.url, `http://${host}`);
  if (url.pathname !== "/api/responses") return { status: 404, statusText: "Not Found" };
  if (request.headers.upgrade?.toLowerCase() !== "websocket")
    return { status: 426, statusText: "Upgrade Required" };
  const origin = request.headers.origin;
  if (!origin || !sameHost(origin, host)) return { status: 403, statusText: "Forbidden" };
  if (!sessionPattern.test(url.searchParams.get("session_id") ?? ""))
    return { status: 400, statusText: "Bad Request" };
  return undefined;
}

export function responsesUpgradeHeaders(
  credential: ResponsesCredential,
  sessionId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.bearer}`,
    "OpenAI-Beta": RESPONSES_WEBSOCKETS_BETA,
    "User-Agent": "rekordbox-library/nanocodex-wasm",
    "session-id": sessionId,
    "thread-id": sessionId,
    "x-client-request-id": sessionId,
    "x-openai-internal-codex-responses-lite": "true",
    "x-responsesapi-include-timing-metrics": "true",
  };
  if (credential.accountId) headers["ChatGPT-Account-ID"] = credential.accountId;
  if (credential.fedramp) headers["X-OpenAI-Fedramp"] = "true";
  return headers;
}

function sameHost(origin: string, host: string): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  socket.close(relayCloseCode(code), Buffer.from(reason).subarray(0, 123).toString());
}

export function relayCloseCode(code: number): number {
  const valid =
    (code >= 1_000 && code <= 1_014 && code !== 1_004 && code !== 1_005 && code !== 1_006) ||
    (code >= 3_000 && code <= 4_999);
  return valid ? code : 1_001;
}
