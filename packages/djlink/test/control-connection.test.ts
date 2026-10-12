import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { requestControl } from "../src/control.js";

it("reports a closed control connection without waiting for the request deadline", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "djlink-control-"));
  const socketPath = resolve(root, "control.sock");
  const server = createServer((socket) => {
    socket.once("data", () => socket.end('{"id":'));
  });
  try {
    await new Promise<void>((ready) => server.listen(socketPath, ready));
    await expect(requestControl(socketPath, "status", {}, 60_000)).rejects.toThrow(
      "connection closed before a complete response",
    );
  } finally {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
