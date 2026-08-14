import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface SessionMetadata {
  schemaVersion: 1;
  purpose: "perfect-recording-trial";
  status: "recording" | "complete";
  pid: number;
  stateUrl: string;
  eventsUrl: string;
  startedAt: string;
  startedUnixUs: number;
  eventFile: string;
  endedAt?: string;
  endedUnixUs?: number;
  recordsWritten?: number;
}

const directoryArgument = process.argv[2];
if (!directoryArgument) throw new Error("recording directory is required");

const directory = resolve(directoryArgument);
const stateUrl = process.env.DJBOOTH_STATE_URL ?? "http://127.0.0.1:4179/v1/state";
const eventsUrl = process.env.DJBOOTH_EVENTS_URL ?? "ws://127.0.0.1:4179/v1/events";
const eventFile = resolve(directory, "events.jsonl");
const metadataFile = resolve(directory, "session.json");
const existingMetadata = existsSync(metadataFile)
  ? (JSON.parse(readFileSync(metadataFile, "utf8")) as Partial<SessionMetadata>)
  : undefined;
const startedAt = existingMetadata?.startedAt ?? new Date().toISOString();
const startedUnixUs = existingMetadata?.startedUnixUs ?? Date.now() * 1_000;

mkdirSync(directory, { recursive: true });
const stream = createWriteStream(eventFile, { flags: "a" });
let socket: WebSocket | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let stopped = false;
let recordsWritten = existsSync(eventFile)
  ? readFileSync(eventFile, "utf8").split("\n").filter(Boolean).length
  : 0;

function write(kind: string, payload: Record<string, unknown> = {}): void {
  const record = {
    capturedAt: new Date().toISOString(),
    capturedUnixUs: Date.now() * 1_000,
    monotonicNs: process.hrtime.bigint().toString(),
    kind,
    ...payload,
  };
  stream.write(`${JSON.stringify(record)}\n`);
  recordsWritten += 1;
}

function writeMetadata(status: SessionMetadata["status"]): void {
  const metadata: SessionMetadata = {
    schemaVersion: 1,
    purpose: "perfect-recording-trial",
    status,
    pid: process.pid,
    stateUrl,
    eventsUrl,
    startedAt,
    startedUnixUs,
    eventFile,
    ...(status === "complete"
      ? {
          endedAt: new Date().toISOString(),
          endedUnixUs: Date.now() * 1_000,
          recordsWritten,
        }
      : {}),
  };
  writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
}

function connect(): void {
  if (stopped) return;
  socket = new WebSocket(eventsUrl);
  socket.addEventListener("open", () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    write("streamConnected");
  });
  socket.addEventListener("message", (message) => {
    try {
      write("hardware", { payload: JSON.parse(String(message.data)) });
    } catch (error) {
      write("recorderError", {
        operation: "parseMessage",
        error: String(error),
        raw: String(message.data),
      });
    }
  });
  socket.addEventListener("error", () => {
    write("streamError");
    scheduleReconnect();
  });
  socket.addEventListener("close", (event) => {
    write("streamDisconnected", { code: event.code, reason: event.reason });
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, 500);
}

async function stop(signal: string): Promise<void> {
  if (stopped) return;
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  write("recordingStopped", { signal });
  writeMetadata("complete");
  socket?.close();
  await new Promise<void>((resolveStream) => stream.end(resolveStream));
  process.exit(0);
}

writeMetadata("recording");
writeFileSync(resolve(directory, "recorder.pid"), `${process.pid}\n`);
try {
  const response = await fetch(stateUrl);
  if (!response.ok) throw new Error(`state endpoint returned HTTP ${response.status}`);
  write("initialState", { payload: await response.json() });
} catch (error) {
  write("recorderError", { operation: "initialState", error: String(error) });
}
connect();
write("recordingStarted");
setInterval(() => write("heartbeat", { recordsWritten }), 5_000);
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
