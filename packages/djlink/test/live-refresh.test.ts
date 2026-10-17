import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { djlinkCli } from "../src/cli.js";
import { runtimePaths } from "../src/control.js";
import {
  loadDjLinkTrack,
  refreshDjLinkLibrary,
  runRekordboxDjLink,
  startRekordboxDjLink,
} from "../src/runtime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function runningSource(
  options: {
    supported?: boolean;
    failRefresh?: boolean;
    failStatus?: boolean;
    model?: string;
    transportError?: string;
  } = {},
) {
  const root = await mkdtemp(resolve(tmpdir(), "djlink-refresh-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, DJBOOTH_DJLINK_STATE_DIR: root };
  const paths = runtimePaths(env);
  const methods: string[] = [];
  let refreshed = false;
  const databasePath = resolve(root, "master.db");
  const binaryPath = resolve(root, "doctor");
  await writeFile(
    binaryPath,
    `#!/bin/sh
echo '{"ok":true,"tracks":2,"playlists":1,"analysis":{"dat":2,"ext":2,"twoEx":2},"missingAudio":[],"missingAnalysis":[]}'
`,
    { mode: 0o700 },
  );
  await writeFile(
    paths.state,
    JSON.stringify({
      schemaVersion: 2,
      pid: process.pid,
      sourceKind: "rekordbox",
      sourcePath: databasePath,
      socketPath: paths.socket,
      logPath: paths.log,
      outputPath: paths.output,
      binaryPath: "/unused/native",
      startedAt: new Date().toISOString(),
    }),
  );
  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      methods.push(request.method);
      let result: unknown;
      let error: string | undefined;
      switch (request.method) {
        case "status":
          if (options.failStatus) {
            error = "control temporarily unavailable";
            break;
          }
          result = {
            pid: process.pid,
            bindIp: "127.0.0.1",
            broadcastIp: "127.255.255.255",
            playerNumber: 18,
            tracks: refreshed ? 2 : 1,
            playlists: 1,
            uptimeMs: 1000,
            stagehandSessionNonce: "123",
            stagehandProtocolNonce: "456",
            remoteTransportSupported: true,
            libraryRefreshSupported: options.supported ?? true,
          };
          break;
        case "refreshLibrary":
          if (options.failRefresh) error = "database temporarily unavailable";
          else {
            refreshed = true;
            result = { tracks: 2, playlists: 1, changed: true };
          }
          break;
        case "resolveTrack":
          if (!refreshed && request.params.selector === "new track") error = "track missing";
          else result = { trackId: 42, order: 2, title: "New track", artist: "Artist" };
          break;
        case "devices":
          result = {
            devices: [{ playerNumber: 11, model: options.model ?? "OMNIS-DUO", ip: "127.0.0.1" }],
          };
          break;
        case "load":
          result = {
            trackId: 42,
            player: request.params.player,
            packetsSent: 1,
            loaded: true,
            playing: !options.transportError,
            transportNote: "loaded",
            transportError: options.transportError,
          };
          break;
        default:
          error = `Unexpected method ${request.method}`;
      }
      socket.end(`${JSON.stringify({ id: request.id, ok: !error, result, error })}\n`);
    });
  });
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, resolveReady);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolveClosed, reject) =>
        server.close((error) => (error ? reject(error) : resolveClosed())),
      ),
  );
  return { env, methods, databasePath, paths, binaryPath };
}

describe("live DJ Link library refresh", () => {
  it("accepts OMNIS status IDs at the CLI and preserves a load with unconfirmed playback", async () => {
    const { env } = await runningSource({ transportError: "Remote Play was not confirmed" });
    vi.stubEnv("DJBOOTH_DJLINK_STATE_DIR", env.DJBOOTH_DJLINK_STATE_DIR);
    let output = "";
    let exitCode: number | undefined;
    await djlinkCli.serve(["load", "new track", "--player", "12", "--format", "json"], {
      stdout(value) {
        output += value;
      },
      exit(code) {
        exitCode = code;
      },
    });
    expect(exitCode, output).toBeUndefined();
    expect(JSON.parse(output)).toMatchObject({
      player: 12,
      loaded: true,
      playing: false,
      transportError: "Remote Play was not confirmed",
    });
  });

  it("loads either OMNIS deck through one appliance identity without claiming remote Play", async () => {
    const { env, databasePath, binaryPath } = await runningSource({
      transportError: "Remote Play was not confirmed",
    });
    for (const player of [1, 2, 11, 12]) {
      await expect(
        runRekordboxDjLink({
          env,
          databasePath,
          binaryPath,
          bindIp: "127.0.0.1",
          selector: "new track",
          player,
          waitMs: 0,
        }),
      ).resolves.toMatchObject({
        load: {
          player,
          loaded: true,
          playing: false,
          transportError: "Remote Play was not confirmed",
        },
      });
    }
    await expect(
      runRekordboxDjLink({
        env,
        databasePath,
        binaryPath,
        bindIp: "127.0.0.1",
        selector: "new track",
        player: 3,
        waitMs: 0,
      }),
    ).rejects.toThrow("Player 3 was not discovered");
  });

  it("does not assign OMNIS aliases to another device model", async () => {
    const { env, databasePath, binaryPath } = await runningSource({ model: "rekordbox" });
    await expect(
      runRekordboxDjLink({
        env,
        databasePath,
        binaryPath,
        bindIp: "127.0.0.1",
        selector: "new track",
        player: 2,
        waitMs: 0,
      }),
    ).rejects.toThrow("Player 2 was not discovered");
  });

  it("never stops a live source after a failed status request", async () => {
    const { env, methods, databasePath } = await runningSource({ failStatus: true });
    await expect(
      startRekordboxDjLink({ env, databasePath, binaryPath: "/bin/true" }),
    ).rejects.toThrow("playback has been left running");
    expect(methods).not.toContain("stop");
  });

  it("preserves a responding source whose daemon state is missing", async () => {
    const { env, methods, databasePath, paths } = await runningSource();
    await unlink(paths.state);
    await expect(
      startRekordboxDjLink({ env, databasePath, binaryPath: "/bin/true" }),
    ).rejects.toThrow("existing server has been left running");
    expect(methods).not.toContain("stop");
    await expect(refreshDjLinkLibrary({ env })).rejects.toThrow("not running");
    // The socket remains reachable even though this client cannot adopt it yet.
    const { requestControl } = await import("../src/control.js");
    await expect(requestControl(paths.socket, "status")).resolves.toMatchObject({
      pid: process.pid,
    });
  });

  it("refreshes before resolving a newly imported track without stopping the source", async () => {
    const { env, methods } = await runningSource();
    await expect(loadDjLinkTrack({ env, selector: "new track", player: 2 })).resolves.toMatchObject(
      {
        trackId: 42,
        player: 2,
        loaded: true,
      },
    );
    expect(methods.filter((method) => method !== "status")).toEqual([
      "refreshLibrary",
      "resolveTrack",
      "load",
    ]);
  });

  it("refreshes without sending any deck transport commands", async () => {
    const { env, methods } = await runningSource();
    await expect(refreshDjLinkLibrary({ env })).resolves.toEqual({
      tracks: 2,
      playlists: 1,
      changed: true,
    });
    expect(methods.filter((method) => method !== "status")).toEqual(["refreshLibrary"]);
  });

  it("keeps an older daemon running and permits existing-track loads", async () => {
    const { env, methods } = await runningSource({ supported: false });
    await expect(refreshDjLinkLibrary({ env })).rejects.toThrow("left running");
    await expect(
      loadDjLinkTrack({ env, selector: "existing track", player: 2 }),
    ).resolves.toMatchObject({ loaded: true });
    expect(methods).not.toContain("stop");
    expect(methods).not.toContain("refreshLibrary");
  });

  it("does not fall back to a restart when refresh fails", async () => {
    const { env, methods } = await runningSource({ failRefresh: true });
    await expect(loadDjLinkTrack({ env, selector: "new track", player: 2 })).rejects.toThrow(
      "database temporarily unavailable",
    );
    expect(methods).not.toContain("stop");
    expect(methods).not.toContain("load");
  });

  it("preserves the running player number when no override is supplied", async () => {
    const { env, databasePath, methods } = await runningSource();
    await expect(
      startRekordboxDjLink({ env, databasePath, bindIp: "127.0.0.1" }),
    ).resolves.toMatchObject({
      resumed: true,
      pid: process.pid,
      playerNumber: 18,
    });
    expect(methods.every((method) => method === "status")).toBe(true);
  });

  it("refuses an identity change without stopping a running source", async () => {
    const { env, databasePath, methods } = await runningSource();
    await expect(startRekordboxDjLink({ env, databasePath, playerNumber: 17 })).rejects.toThrow(
      "different network/player identity",
    );
    expect(methods).not.toContain("stop");
  });
});
