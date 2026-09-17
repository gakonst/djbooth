import { spawn, type ChildProcess } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { startLibraryServer, type RunningLibraryServer } from "@gakonst/djbooth-app";
import { Cli, z } from "incur";
import { WebSocketServer } from "ws";

type ReplayMessage = Record<string, unknown> & { type?: unknown };

type RecordedRow = {
  capturedAt?: unknown;
  kind?: unknown;
  payload?: unknown;
};

export type HardwareReplayEvent = {
  offsetMs: number;
  message: ReplayMessage;
};

export type HardwareReplay = {
  durationMs: number;
  events: HardwareReplayEvent[];
  from: string;
  source: string;
  to: string;
};

type CdpResponse = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

const defaultChromePaths = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

/** Read one bounded hardware timeline as an initial checkpoint followed by event deltas. */
export async function loadHardwareReplay(options: {
  from: string;
  recording: string;
  to: string;
}): Promise<HardwareReplay> {
  const source = resolveRecordingPath(options.recording);
  const fromMs = parseTimestamp(options.from, "from");
  const toMs = parseTimestamp(options.to, "to");
  if (toMs <= fromMs) throw new TypeError("Replay --to must be later than --from");

  let checkpoint: ReplayMessage | undefined;
  let checkpointDeltas: HardwareReplayEvent[] = [];
  const events: HardwareReplayEvent[] = [];
  let lastMeterBucket = -1;
  const lines = createInterface({ input: createReadStream(source), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let row: RecordedRow;
    try {
      row = JSON.parse(line) as RecordedRow;
    } catch {
      continue;
    }
    if (row.kind !== "hardware" || !isReplayMessage(row.payload)) continue;
    const capturedMs = typeof row.capturedAt === "string" ? Date.parse(row.capturedAt) : Number.NaN;
    if (!Number.isFinite(capturedMs)) continue;
    if (capturedMs < fromMs) {
      if (row.payload.type === "snapshot") {
        checkpoint = row.payload;
        checkpointDeltas = [];
      } else if (checkpoint) {
        checkpointDeltas.push({ offsetMs: 0, message: row.payload });
      }
      continue;
    }
    if (capturedMs > toMs) break;
    if (row.payload.type === "snapshot") {
      if (!checkpoint) {
        checkpoint = row.payload;
        continue;
      }
      // Network A9 controls and device discovery arrive as snapshots, without
      // separate control deltas. Dropping them loses mixer moves during replay.
    }
    const offsetMs = capturedMs - fromMs;
    if (row.payload.type === "meters") {
      const bucket = Math.floor(offsetMs / (1_000 / 30));
      if (bucket === lastMeterBucket) continue;
      lastMeterBucket = bucket;
    }
    events.push({ offsetMs, message: row.payload });
  }
  if (!checkpoint) throw new Error(`Recording has no state checkpoint before ${options.from}`);
  events.unshift({ offsetMs: 0, message: checkpoint }, ...checkpointDeltas);
  return {
    durationMs: toMs - fromMs,
    events,
    from: new Date(fromMs).toISOString(),
    source,
    to: new Date(toMs).toISOString(),
  };
}

/** Render the exact live booth UI against a recorded timeline and encode it as H.264 video. */
export async function renderHardwareReplay(options: {
  boothUrl?: string;
  chromePath?: string;
  fps?: number;
  from: string;
  height?: number;
  output: string;
  recording: string;
  speed?: number;
  to: string;
  width?: number;
}): Promise<{
  durationMs: number;
  events: number;
  frames: number;
  output: string;
  source: string;
}> {
  const replay = await loadHardwareReplay(options);
  const width = options.width ?? 1_920;
  const height = options.height ?? 1_080;
  const fps = options.fps ?? 30;
  const speed = options.speed ?? 1;
  const output = resolve(options.output);
  const chromePath = resolveChromePath(options.chromePath);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "djbooth-replay-"));
  const framesDirectory = join(temporaryRoot, "frames");
  mkdirSync(framesDirectory);
  mkdirSync(dirname(output), { recursive: true });

  const replaySocket = await startReplaySocket(replay.events, replay.durationMs, speed);
  let boothServer: RunningLibraryServer | undefined;
  if (!options.boothUrl) {
    boothServer = await startLibraryServer({
      assistantEnabled: false,
      host: "127.0.0.1",
      hosted: false,
      port: 0,
      writeEnabled: false,
    });
  }
  const debuggingPort = await reservePort();
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${String(debuggingPort)}`,
      `--user-data-dir=${join(temporaryRoot, "chrome")}`,
      `--window-size=${String(width)},${String(height)}`,
      "--hide-scrollbars",
      "--autoplay-policy=no-user-gesture-required",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  try {
    await waitForChrome(debuggingPort, chrome);
    const target = await createChromeTarget(debuggingPort);
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    try {
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const boothUrl = new URL(options.boothUrl ?? new URL("/booth", boothServer!.url).toString());
      boothUrl.searchParams.set("assistant", "0");
      boothUrl.searchParams.set("hardwareWs", replaySocket.url);
      await cdp.send("Page.navigate", { url: boothUrl.toString() });
      await replaySocket.waitForConnection(15_000);
      await delay(500);

      const frames: Array<{ path: string; timestamp: number }> = [];
      let frameIndex = 0;
      cdp.on("Page.screencastFrame", (params) => {
        const data = typeof params.data === "string" ? params.data : undefined;
        const sessionId = typeof params.sessionId === "number" ? params.sessionId : undefined;
        const metadata = isRecord(params.metadata) ? params.metadata : {};
        const timestamp = typeof metadata.timestamp === "number" ? metadata.timestamp : 0;
        if (data) {
          const path = join(framesDirectory, `${String(frameIndex++).padStart(6, "0")}.jpg`);
          writeFileSync(path, Buffer.from(data, "base64"));
          frames.push({ path, timestamp });
        }
        if (sessionId !== undefined)
          void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
      });
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 92,
        maxWidth: width,
        maxHeight: height,
        everyNthFrame: 1,
      });
      await replaySocket.start();
      await delay(500);
      await cdp.send("Page.stopScreencast");
      if (frames.length < 2) throw new Error("Chrome produced too few replay frames");
      const concatPath = writeFrameConcat(temporaryRoot, frames, replay.durationMs / speed);
      await runFfmpeg(concatPath, output, fps);
      return {
        durationMs: replay.durationMs / speed,
        events: replay.events.length,
        frames: frames.length,
        output,
        source: replay.source,
      };
    } finally {
      cdp.close();
    }
  } finally {
    await stopProcess(chrome);
    await replaySocket.close();
    await boothServer?.close();
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

export const replayCli = Cli.create("replay", {
  description: "Replay recorded CDJ/A9 telemetry through the exact booth UI and render a video.",
  hint: "Pass the recording session directory plus absolute ISO --from/--to timestamps.",
  args: z.object({
    recording: z.string().min(1).describe("Recording session directory or events.jsonl path"),
  }),
  options: z.object({
    boothUrl: z
      .url()
      .optional()
      .describe("Compatible running booth URL; defaults to an isolated local replay server"),
    chrome: z.string().optional().describe("Chrome or Brave executable override"),
    fps: z.number().int().min(1).max(60).default(30),
    from: z.iso.datetime().describe("Inclusive recording timestamp"),
    height: z.number().int().min(360).max(2_160).default(1_080),
    output: z
      .string()
      .default(join(homedir(), "Movies", "djbooth-replay.mp4"))
      .describe("Output MP4 path"),
    speed: z.number().positive().max(8).default(1),
    to: z.iso.datetime().describe("Exclusive recording timestamp"),
    width: z.number().int().min(640).max(3_840).default(1_920),
  }),
  output: z.object({
    durationMs: z.number().nonnegative(),
    events: z.number().int().nonnegative(),
    frames: z.number().int().positive(),
    output: z.string(),
    source: z.string(),
  }),
  async run(context) {
    return renderHardwareReplay({
      ...(context.options.boothUrl ? { boothUrl: context.options.boothUrl } : {}),
      ...(context.options.chrome ? { chromePath: context.options.chrome } : {}),
      fps: context.options.fps,
      from: context.options.from,
      output: context.options.output,
      recording: context.args.recording,
      speed: context.options.speed,
      to: context.options.to,
      width: context.options.width,
    });
  },
});

class CdpClient {
  private id = 0;
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private readonly pending = new Map<
    number,
    { reject(error: Error): void; resolve(value: CdpResponse): void }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => {
      for (const request of this.pending.values())
        request.reject(new Error("Chrome DevTools connection closed"));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true });
      socket.addEventListener("error", () => rejectOpen(new Error("Could not connect to Chrome")), {
        once: true,
      });
    });
    return new CdpClient(socket);
  }

  close(): void {
    this.socket.close();
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<CdpResponse> {
    const id = ++this.id;
    const response = new Promise<CdpResponse>((resolveResponse, rejectResponse) => {
      this.pending.set(id, { reject: rejectResponse, resolve: resolveResponse });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    const message = await response;
    if (message.error) throw new Error(message.error.message ?? `Chrome command ${method} failed`);
    return message;
  }

  private receive(raw: string): void {
    const message = JSON.parse(raw) as CdpResponse;
    if (message.id !== undefined) {
      const request = this.pending.get(message.id);
      if (request) {
        this.pending.delete(message.id);
        request.resolve(message);
      }
      return;
    }
    if (!message.method) return;
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
  }
}

type RunningReplaySocket = {
  close(): Promise<void>;
  start(): Promise<void>;
  url: string;
  waitForConnection(timeoutMs: number): Promise<void>;
};

async function startReplaySocket(
  events: HardwareReplayEvent[],
  durationMs: number,
  speed: number,
): Promise<RunningReplaySocket> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("listening", resolveListening);
    server.once("error", rejectListening);
  });
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("Replay WebSocket has no port");
  const clients = new Set<import("ws").WebSocket>();
  const connectionWaiters = new Set<() => void>();
  server.on("connection", (client) => {
    clients.add(client);
    client.once("close", () => clients.delete(client));
    for (const resolveConnection of connectionWaiters) resolveConnection();
    connectionWaiters.clear();
  });
  let started = false;
  return {
    url: `ws://127.0.0.1:${String(address.port)}`,
    async close() {
      for (const client of clients) client.close();
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    },
    async start() {
      if (started) throw new Error("Replay timeline has already started");
      if (!clients.size) throw new Error("Booth did not connect to the replay timeline");
      started = true;
      const timers: NodeJS.Timeout[] = [];
      for (const event of events) {
        timers.push(
          setTimeout(() => {
            const payload = JSON.stringify(event.message);
            for (const client of clients) if (client.readyState === 1) client.send(payload);
          }, event.offsetMs / speed),
        );
      }
      await delay(durationMs / speed);
      for (const timer of timers) clearTimeout(timer);
    },
    async waitForConnection(timeoutMs) {
      if (clients.size) return;
      await Promise.race([
        new Promise<void>((resolveConnection) => connectionWaiters.add(resolveConnection)),
        delay(timeoutMs).then(() => {
          throw new Error("Timed out waiting for booth replay WebSocket connection");
        }),
      ]);
    },
  };
}

function isReplayMessage(value: unknown): value is ReplayMessage {
  return isRecord(value) && typeof value.type === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTimestamp(value: string, name: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`Invalid replay --${name} timestamp`);
  return timestamp;
}

function resolveRecordingPath(input: string): string {
  const path = resolve(input);
  const source = extname(path) === ".jsonl" ? path : join(path, "events.jsonl");
  if (!existsSync(source)) throw new Error(`Recording does not exist: ${source}`);
  return source;
}

function resolveChromePath(override?: string): string {
  if (override) {
    const path = resolve(override);
    if (!existsSync(path)) throw new Error(`Chrome executable does not exist: ${path}`);
    return path;
  }
  const path = defaultChromePaths.find(existsSync);
  if (!path) throw new Error("Google Chrome or Brave Browser is required to render booth replay");
  return path;
}

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createNetServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) rejectPort(error);
        else if (port === undefined) rejectPort(new Error("Could not reserve Chrome port"));
        else resolvePort(port);
      });
    });
  });
}

async function waitForChrome(port: number, process: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null)
      throw new Error(`Chrome exited with code ${String(process.exitCode)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome has not opened its debugging socket yet.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Chrome DevTools");
}

async function createChromeTarget(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/json/new?about:blank`, {
    method: "PUT",
  });
  if (!response.ok)
    throw new Error(`Could not create Chrome page: HTTP ${String(response.status)}`);
  const target = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof target.webSocketDebuggerUrl !== "string")
    throw new Error("Chrome page has no DevTools WebSocket URL");
  return { webSocketDebuggerUrl: target.webSocketDebuggerUrl };
}

function writeFrameConcat(
  temporaryRoot: string,
  frames: Array<{ path: string; timestamp: number }>,
  expectedDurationMs: number,
): string {
  const usableTimestamps = frames.every((frame) => frame.timestamp > 0);
  const fallbackDuration = expectedDurationMs / Math.max(1, frames.length - 1) / 1_000;
  const lines = ["ffconcat version 1.0"];
  for (let index = 0; index < frames.length - 1; index += 1) {
    const frame = frames[index]!;
    const next = frames[index + 1]!;
    const duration = usableTimestamps
      ? Math.max(1 / 120, Math.min(0.25, next.timestamp - frame.timestamp))
      : fallbackDuration;
    lines.push(`file '${escapeConcatPath(frame.path)}'`, `duration ${duration.toFixed(9)}`);
  }
  lines.push(`file '${escapeConcatPath(frames.at(-1)!.path)}'`);
  const path = join(temporaryRoot, "frames.ffconcat");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function escapeConcatPath(path: string): string {
  return path.replaceAll("'", "'\\''");
}

async function runFfmpeg(concatPath: string, output: string, fps: number): Promise<void> {
  await runProcess("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatPath,
    "-vf",
    `fps=${String(fps)},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
    "-movflags",
    "+faststart",
    output,
  ]);
}

async function runProcess(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", rejectProcess);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveProcess();
      else rejectProcess(new Error(`${executable} failed (${String(code ?? signal)}): ${stderr}`));
    });
  });
}

async function stopProcess(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => process.once("exit", () => resolveExit())),
    delay(2_000).then(() => {
      if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
    }),
  ]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
