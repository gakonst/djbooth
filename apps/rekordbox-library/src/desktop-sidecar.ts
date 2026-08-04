#!/usr/bin/env node

import { parseArgs } from "node:util";

import { startLibraryServer } from "./server/server.js";

const { values } = parseArgs({
  allowPositionals: false,
  options: {
    host: { type: "string", default: "127.0.0.1" },
    path: { type: "string" },
    port: { type: "string", default: "0" },
    "read-only": { type: "boolean", default: false },
    "static-directory": { type: "string" },
  },
  strict: true,
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535)
  throw new TypeError("port must be an integer between 0 and 65535");

const server = await startLibraryServer({
  dbPath: values.path,
  host: values.host,
  port,
  staticDirectory: values["static-directory"],
  writeEnabled: !values["read-only"],
});
process.stdout.write(`${JSON.stringify({ type: "ready", url: server.url })}\n`);

await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});
await server.close();
