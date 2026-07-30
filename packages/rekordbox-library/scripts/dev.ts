#!/usr/bin/env node

import { parseArgs } from "node:util";
import { resolve } from "node:path";

import { createServer as createViteServer } from "vite";

import { startLibraryServer } from "../src/server/server.js";

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    "api-port": { type: "string", default: "0" },
    host: { type: "string", default: "127.0.0.1" },
    open: { type: "boolean", default: false },
    path: { type: "string" },
    port: { type: "string", default: "4179" },
    "read-only": { type: "boolean", default: false },
  },
  strict: true,
});

const host = values.host ?? "127.0.0.1";
const port = parsePort(values.port, "port");
const apiPort = parsePort(values["api-port"], "api-port");
const packageRoot = resolve(import.meta.dirname, "..");
process.env.NODE_ENV = "development";

const api = await startLibraryServer({
  dbPath: values.path,
  host,
  port: apiPort,
  writeEnabled: !values["read-only"],
});

let vite;
try {
  vite = await createViteServer({
    root: packageRoot,
    mode: "development",
    server: {
      host,
      open: values.open,
      port,
      proxy: {
        "/api": {
          target: api.url,
          changeOrigin: false,
          ws: true,
        },
      },
      strictPort: true,
    },
  });
  await vite.listen();
} catch (error) {
  await api.close();
  throw error;
}

vite.printUrls();
process.stderr.write(
  `  API: ${api.url} (SQLite writes ${values["read-only"] ? "disabled" : "enabled"})\n`,
);

let shutdownPromise: Promise<void> | undefined;
const shutdown = (): Promise<void> => {
  shutdownPromise ??= Promise.all([vite.close(), api.close()]).then(() => undefined);
  return shutdownPromise;
};
const stop = () => {
  void shutdown().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
vite.httpServer?.once("close", stop);

function parsePort(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new TypeError(`${name} must be an integer between 0 and 65535`);
  }
  return parsed;
}
