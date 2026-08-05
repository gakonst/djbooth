import { writeFile, unlink } from "node:fs/promises";

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
const state: DjBoothRuntimeState = {
  version: DJBOOTH_RUNTIME_VERSION,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  url: server.url,
  assistantEnabled: server.assistantEnabled,
  options,
  link: server.link,
  logPath: paths.log,
};
await writeFile(paths.state, `${JSON.stringify(state)}\n`, { mode: 0o600 });

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try {
    await server.close();
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
