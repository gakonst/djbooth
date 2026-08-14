import { unlink, writeFile } from "node:fs/promises";

import { startDjBoothServer, type DjBoothServerOptions } from "./serve.js";
import {
  DJBOOTH_RUNTIME_VERSION,
  djBoothRuntimePaths,
  type DjBoothRuntimeState,
} from "./runtime.js";

const payload = process.argv[2];
if (!payload) throw new TypeError("Missing managed server configuration");
const options = JSON.parse(
  Buffer.from(payload, "base64url").toString("utf8"),
) as DjBoothServerOptions;
const paths = djBoothRuntimePaths();
const server = await startDjBoothServer(options);
let state: DjBoothRuntimeState = {
  version: DJBOOTH_RUNTIME_VERSION,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  url: server.url,
  assistantEnabled: server.assistantEnabled,
  options,
  link: server.link,
  logPath: paths.log,
  monitorUrl: server.boothUrl,
  sonos: server.sonos,
};
await writeFile(paths.state, `${JSON.stringify(state)}\n`, { mode: 0o600 });

let closing = false;
let lastReconcileError: string | undefined;
const reconcileLoop = monitorLink();
const close = async () => {
  if (closing) return;
  closing = true;
  try {
    await server.close();
    await reconcileLoop;
  } finally {
    await unlink(paths.state).catch(() => undefined);
  }
};
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
process.once("uncaughtException", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  void close().finally(() => process.exit(1));
});
process.once("unhandledRejection", (error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  void close().finally(() => process.exit(1));
});

await new Promise(() => undefined);

async function monitorLink(): Promise<void> {
  while (!closing) {
    await delay(2_000);
    if (closing) break;
    try {
      const previousPid = state.link?.pid;
      const previousBindIp = state.link?.bindIp;
      const link = await server.reconcileLink();
      if (closing) break;
      if (link?.pid !== previousPid || link?.bindIp !== previousBindIp) {
        state = { ...state, link, sonos: server.sonos };
        await writeFile(paths.state, `${JSON.stringify(state)}\n`, { mode: 0o600 });
        process.stderr.write(
          `DJ Link reconciled on ${link?.bindIp ?? "no interface"} (PID ${String(link?.pid ?? 0)})\n`,
        );
      }
      if (lastReconcileError) {
        process.stderr.write("DJ Link connectivity recovered\n");
        lastReconcileError = undefined;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastReconcileError) {
        process.stderr.write(`DJ Link reconnect pending: ${message}\n`);
        lastReconcileError = message;
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
